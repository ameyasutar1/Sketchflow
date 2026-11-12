"""Opt-in live Gemini smoke check. Uses only a synthetic empty board; incurs API usage."""
import asyncio
import os
import re
import tempfile
import argparse
import sqlite3
from unittest.mock import patch
from langchain_core.messages import AIMessage
from pathlib import Path
from backend.agent import run_agent
from backend.schemas import Canvas, ChatRequest
from backend.storage import Storage

class Browser:
    def __init__(self,path):
        self.board='smoke'
        self.storage=Storage(path)
        self.pending={}
        self.canvas=Canvas(revision=1,page_id='page:main',shapes=[])
        self.operations=[]

    async def send(self,event):
        if event['type']=='actions':
            print('Validated batch:', len(event['operations']), 'operations', flush=True)
            self.operations.extend(event['operations'])
            for op in event['operations']:
                if op['op'] in ('create_shape','add_text','draw_stroke','create_arrow'):
                    self.canvas.shapes.append({'id':op['id'],'type':op['op'],'x':op['x'],'y':op['y'],'text':op['text']})
            self.canvas.revision+=1
            self.pending[event['batch_id']].set_result({'ok':True,'revision':self.canvas.revision})

async def main():
    with tempfile.TemporaryDirectory() as directory:
        browser=Browser(Path(directory)/'smoke.db')
        request=ChatRequest(type='chat',request_id='smoke',message=ARGS.prompt,canvas=browser.canvas.model_copy(deep=True))
        history = []
        if ARGS.history_board:
            from backend.config import DATA
            with sqlite3.connect(f'file:{DATA / "canvas.sqlite3"}?mode=ro', uri=True) as db:
                rows = db.execute('SELECT role, content FROM messages WHERE board=? ORDER BY seq DESC LIMIT 24', (ARGS.history_board,)).fetchall()
            history = [{'role': r[0], 'content': r[1]} for r in reversed(rows)]
        class BrokenGraph:
            def __init__(self, tools):
                self.edit = next(t for t in tools if t.name == 'edit_canvas')
            async def astream(self, *args, **kwargs):
                if ARGS.partial_recovery:
                    labels = ['Input tokens', 'Input embedding + positional encoding',
                              'Encoder self-attention', 'Encoder feed-forward',
                              'Output embedding + positional encoding', 'Masked decoder self-attention',
                              'Encoder-decoder cross-attention', 'Linear + softmax']
                    await self.edit.ainvoke({'operations': [
                        {'op': 'create_shape', 'id': f'shape:stage_{i}', 'text': label,
                         'x': (i // 4) * 500, 'y': (i % 4) * 200, 'w': 300, 'h': 100}
                        for i, label in enumerate(labels)], 'explanation': 'Create eight initial Transformer boxes'})
                yield 'values', {'messages': [AIMessage(content='', response_metadata={'finish_reason': 'MALFORMED_FUNCTION_CALL'})]}
        try:
            async with asyncio.timeout(150):
                if ARGS.structured_recovery or ARGS.partial_recovery:
                    with patch('backend.agent.create_deep_agent', side_effect=lambda **kw: BrokenGraph(kw['tools'])):
                        answer=await run_agent(browser,request,history)
                else:
                    answer=await run_agent(browser,request,history)
        except Exception as error:
            print('Live smoke failed:',type(error).__name__)
            detail=str(error)
            for name in ('GOOGLE_API_KEY','GEMINI_API_KEY'):
                if os.getenv(name): detail=detail.replace(os.environ[name], '[REDACTED]')
            detail=re.sub(r'AIza[\w-]+', '[REDACTED]', detail)
            print(detail[:1800])
            raise SystemExit(1) from None
        assert browser.operations, 'No canvas operations were produced'
        if ARGS.partial_recovery:
            assert len(browser.operations) > 8, 'No continuation was applied'
            for i in range(8):
                assert sum(op['id'] == f'shape:stage_{i}' and op['op'] == 'create_shape'
                           for op in browser.operations) == 1, 'Initial box replayed'
        if ARGS.diagram:
            assert sum(op['op']=='create_shape' for op in browser.operations) >= 6, 'Diagram missing boxes'
            assert sum(op['op']=='create_arrow' for op in browser.operations) >= 5, 'Diagram missing connectors'
        print('Shapes:', sum(op['op']=='create_shape' for op in browser.operations),
              'Arrows:', sum(op['op']=='create_arrow' for op in browser.operations),
              'Labeled notes:', sum(op['op']=='add_text' for op in browser.operations))
        else:
            assert any(op['op']=='draw_stroke' for op in browser.operations), 'No stroke was produced'
        print('PASS: Gemini → Deep Agents → validated drawing tool → browser acknowledgement')
        print('Operations:',len(browser.operations),'Response characters:',len(answer))

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--prompt',default='Draw exactly one black smooth wave with draw_stroke using 20 points. Use edit_canvas. Keep your final response to one sentence.')
    parser.add_argument('--diagram', action='store_true', help='Validate boxes and connectors instead of a stroke')
    parser.add_argument('--structured-recovery', action='store_true', help='Inject malformed tool responses to test real-provider JSON recovery')
    parser.add_argument('--partial-recovery', action='store_true', help='Apply eight boxes, then inject a malformed response and verify continuation')
    parser.add_argument('--history-board', help='Read saved board conversation without changing it')
    ARGS=parser.parse_args()
    asyncio.run(main())
