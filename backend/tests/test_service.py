import asyncio
import json
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from starlette.websockets import WebSocketDisconnect
from backend.main import create_app
from backend.schemas import Canvas, EditBatch, Operation, validate_targets
from backend.storage import Storage

ORIGIN={'origin':'http://localhost:5173'}
CANVAS={'revision':1,'page_id':'page:main','shapes':[]}

def chat(id='request1'):
    return {'type':'chat','request_id':id,'message':'draw a wave','canvas':CANVAS}

async def drawing_runner(session,request,history):
    future=asyncio.get_running_loop().create_future()
    session.pending['batch1']=future
    await session.send({'type':'actions','batch_id':'batch1','request_id':request.request_id,
                        'operations':[{'op':'draw_stroke','id':'shape:wave','points':[{'x':0,'y':0},{'x':100,'y':50}]}]})
    result=await future
    return 'Wave applied.' if result['ok'] else 'Edit declined.'

def test_browser_ack_and_durable_history(tmp_path):
    db=tmp_path/'test.db'
    with TestClient(create_app(db,drawing_runner)) as client:
        with client.websocket_connect('/api/ws/board1',headers=ORIGIN) as ws:
            assert ws.receive_json()['type']=='ready'
            ws.send_json(chat())
            assert ws.receive_json()['type']=='started'
            assert ws.receive_json()['type']=='actions'
            ws.send_json({'type':'ack','batch_id':'batch1','ok':True,'canvas':{**CANVAS,'revision':2}})
            result=ws.receive_json()
            assert result['type']=='done' and result['message']=='Wave applied.'
            ws.send_json(chat())
            assert ws.receive_json()['type']=='error' # duplicate request never reruns edits
    with TestClient(create_app(db,drawing_runner)) as client:
        with client.websocket_connect('/api/ws/board1',headers=ORIGIN) as ws:
            history=ws.receive_json()['history']
            assert len(history)==2 and history[-1]['content']=='Wave applied.'
        with client.websocket_connect('/api/ws/other',headers=ORIGIN) as ws:
            assert ws.receive_json()['history']==[]

async def wait_runner(session,request,history):
    await asyncio.sleep(100)


def test_cancel_invalid_events_and_origin(tmp_path):
    with TestClient(create_app(tmp_path/'test.db',wait_runner)) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('/api/ws/board',headers={'origin':'https://evil.example'}): pass
        with client.websocket_connect('/api/ws/board',headers=ORIGIN) as ws:
            ws.receive_json()
            ws.send_text('{broken')
            assert ws.receive_json()['type']=='error'
            ws.send_json(chat())
            assert ws.receive_json()['type']=='started'
            ws.send_json({'type':'cancel'})
            assert ws.receive_json()['status']=='cancelled'
            ws.send_json({'type':'ping'})
            assert ws.receive_json()['type']=='pong'


def test_disconnect_cancels_and_second_tab_is_rejected(tmp_path):
    with TestClient(create_app(tmp_path/'test.db',wait_runner)) as client:
        with client.websocket_connect('/api/ws/board',headers=ORIGIN) as ws:
            ws.receive_json()
            with client.websocket_connect('/api/ws/board',headers=ORIGIN) as second:
                assert second.receive_json()['type']=='error'
            ws.send_json(chat())
            assert ws.receive_json()['type']=='started'
        assert client.app.state.storage.history('board')[-1]['content'].startswith('Stopped.')


def test_limits_and_references():
    with pytest.raises(ValidationError): Operation(op='draw_stroke',id='shape:a',points=[])
    with pytest.raises(ValidationError): Operation(op='move_shape',id='shape:a',x=float('nan'))
    with pytest.raises(ValidationError): Operation(op='execute',id='shape:a')
    with pytest.raises(ValidationError): Operation(op='create_shape',id='../../secret')
    batch=EditBatch(operations=[Operation(op='delete_shape',id='shape:a')],explanation='delete')
    with pytest.raises(ValueError): validate_targets(batch,Canvas(**CANVAS))
    with pytest.raises(ValueError): validate_targets(batch,Canvas(**{**CANVAS,'shapes':[{'id':'shape:a','locked':True}]}))
    operations=[Operation(op='create_shape',id='shape:a'),Operation(op='create_shape',id='shape:b'),Operation(op='create_arrow',id='shape:c',from_id='shape:a',to_id='shape:b')]
    validate_targets(EditBatch(operations=operations,explanation='connected nodes'),Canvas(**CANVAS))


def test_provider_error_is_redacted(tmp_path):
    async def failing(*args): raise RuntimeError('secret-key-do-not-expose')
    with TestClient(create_app(tmp_path/'test.db',failing)) as client:
        with client.websocket_connect('/api/ws/board',headers=ORIGIN) as ws:
            ws.receive_json();ws.send_json(chat());ws.receive_json()
            event=ws.receive_json()
            assert event['status']=='failed'
            assert 'secret-key' not in json.dumps(event)


def test_canvas_image_accepts_inline_and_rejects_remote_urls():
    import base64
    from backend.schemas import ChatRequest
    png='data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\nfixture').decode()
    request=ChatRequest(**{**chat(),'canvas_image':png})
    assert request.canvas_image==png
    for image in ['https://example.com/image.png','data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,bm90LWFuLWltYWdl']:
        with pytest.raises(ValidationError): ChatRequest(**{**chat(),'canvas_image':image})
