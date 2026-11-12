import asyncio
import contextlib
import json
import logging
import os
import re
import sys
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from langchain_google_genai.chat_models import GoogleRateLimitError
if __package__ in (None, ''):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.config import DATA, MAX_FRAME, MODEL, ORIGINS, ROOT
from backend.schemas import Canvas, ChatRequest
from backend.storage import Storage

log = logging.getLogger('canvas')

class Session:
    def __init__(self, ws, board, storage):
        self.ws, self.board, self.storage = ws, board, storage
        self.canvas = Canvas(revision=0, page_id='', shapes=[])
        self.pending = {}
        self.task = None
        self.send_lock = asyncio.Lock()

    async def send(self, event):
        async with self.send_lock:
            await self.ws.send_json(event)

    async def stop(self):
        if self.task and not self.task.done():
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError, RuntimeError):
                await self.task

def create_app(storage_path=None, runner=None):
    sessions = {}

    @asynccontextmanager
    async def lifespan(app):
        app.state.storage = Storage(storage_path or DATA / 'canvas.sqlite3')
        yield
        for session in list(sessions.values()):
            await session.stop()

    app = FastAPI(title='Canvas agent', version='1.0.0', lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=list(ORIGINS), allow_methods=['GET'], allow_headers=['Content-Type'])
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=['localhost', '127.0.0.1', 'testserver'])

    @app.get('/api/health')
    async def health():
        return {'status': 'ok', 'agent_configured': bool(os.getenv('GOOGLE_API_KEY')), 'model': MODEL}

    @app.websocket('/api/ws/{board}')
    async def websocket(ws: WebSocket, board: str):
        if ws.headers.get('origin') not in ORIGINS or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', board):
            await ws.close(code=1008)
            return
        await ws.accept()
        if board in sessions:
            await ws.send_json({'type': 'error', 'message': 'This board is connected in another tab. Close that tab or open a new board.'})
            await ws.close(code=1008)
            return
        session = Session(ws, board, app.state.storage)
        sessions[board] = session
        storage = app.state.storage

        async def execute(request):
            history = storage.history(board)
            if not storage.start(board, request.request_id, request.message):
                await session.send({'type': 'error', 'request_id': request.request_id, 'message': 'This request was already received. Check history before sending again.'})
                return
            await session.send({'type': 'started', 'request_id': request.request_id})
            status = 'complete'
            try:
                from backend.agent import run_agent
                async with asyncio.timeout(240):
                    answer = await (runner or run_agent)(session, request, history)
            except asyncio.CancelledError:
                status, answer = 'cancelled', 'Stopped. Any changes already applied remain on the canvas; you can undo them.'
            except Exception as exc:
                status = 'failed'
                log.warning('Agent run failed: %s', type(exc).__name__)
                if str(exc) == 'missing_key':
                    answer = 'Set GOOGLE_API_KEY in the project .env file and restart the backend.'
                elif isinstance(exc, GoogleRateLimitError):
                    answer = 'Gemini rate limit or quota reached. Wait for your request quota to reset, or check your Gemini project quota. Any confirmed canvas edits remain; ask to continue the remaining work.'
                elif isinstance(exc, ValidationError) or str(exc) == 'invalid_canvas_plan':
                    if isinstance(exc, ValidationError):
                        log.warning('Canvas validation fields: %s',
                                    [{'loc': e['loc'], 'type': e['type']} for e in exc.errors()][:20])
                    answer = 'The generated canvas plan still contained invalid fields after correction. It was not applied. Any edits confirmed earlier in this request remain on the board.'
                elif isinstance(exc, TimeoutError):
                    answer = 'The request timed out. Check the canvas before trying again.'
                elif str(exc) == 'empty_model_response':
                    answer = 'Gemini returned no usable response after recovery. Check the canvas for any applied edits before retrying.'
                elif str(exc) == 'invalid_model_tool_call':
                    answer = 'Gemini could not generate a valid drawing command. Any edits already confirmed remain on the canvas. Please retry the remaining work.'
                elif str(exc) == 'canvas_plan_not_applied':
                    answer = 'The canvas plan was not confirmed. The board may have changed or the edit was declined. Check the canvas before retrying.'
                elif str(exc) == 'model_output_limit':
                    answer = 'Gemini reached its response limit. Any edits already confirmed remain on the canvas. Ask to continue the remaining work.'
                else:
                    answer = 'The model request failed. Check your API key, model access, quota, and network. Applied edits remain on the canvas.'
            finally:
                for future in session.pending.values():
                    if not future.done():
                        future.cancel()
                session.pending.clear()
            storage.finish(board, request.request_id, answer, status)
            with contextlib.suppress(RuntimeError, WebSocketDisconnect, OSError):
                await session.send({'type': 'done', 'request_id': request.request_id, 'message': answer, 'status': status})

        try:
            await session.send({'type': 'ready', 'history': storage.history(board), 'model': MODEL,
                                'configured': bool(os.getenv('GOOGLE_API_KEY'))})
            while True:
                raw = await ws.receive_text()
                if len(raw.encode()) > MAX_FRAME:
                    await ws.close(code=1009)
                    break
                try:
                    event = json.loads(raw)
                    if not isinstance(event, dict):
                        raise ValueError('Expected an object')
                    kind = event.get('type')
                    if kind == 'ping':
                        await session.send({'type': 'pong'})
                    elif kind == 'canvas':
                        session.canvas = Canvas.model_validate(event.get('canvas'))
                    elif kind == 'ack':
                        future = session.pending.get(event.get('batch_id'))
                        if future and not future.done():
                            canvas = Canvas.model_validate(event.get('canvas'))
                            session.canvas = canvas
                            future.set_result({'ok': event.get('ok') is True, 'error': str(event.get('error', ''))[:500], 'revision': canvas.revision})
                    elif kind == 'cancel':
                        await session.stop()
                    elif kind == 'chat':
                        if session.task and not session.task.done():
                            await session.send({'type': 'error', 'message': 'Wait for the current request or stop it first.'})
                            continue
                        request = ChatRequest.model_validate(event)
                        session.canvas = request.canvas
                        session.task = asyncio.create_task(execute(request))
                    else:
                        raise ValueError('Unknown message type')
                except (ValueError, TypeError, ValidationError):
                    await session.send({'type': 'error', 'message': 'Invalid event or canvas data. Reload the page and try again.'})
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            await session.stop()
            sessions.pop(board, None)

    dist = ROOT / 'frontend' / 'dist'
    if dist.exists():
        app.mount('/', StaticFiles(directory=dist, html=True), name='frontend')
    return app

app = create_app()
