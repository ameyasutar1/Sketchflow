"""Exercise the actual Deep Agents tool closures without spending API quota."""
import asyncio
import pytest
from types import SimpleNamespace
from unittest.mock import patch
from unittest.mock import AsyncMock, MagicMock
from backend.agent import run_agent, recover_canvas_plan
from backend.schemas import Canvas, ChatRequest, Operation, EditBatch, validate_targets
from backend.storage import Storage
from langchain_core.messages import AIMessage
from pydantic import ValidationError


@pytest.mark.parametrize('accepted', [True, False])
def test_real_deepagents_loop_executes_structured_plan_without_native_function_calls(tmp_path, monkeypatch, accepted):
    monkeypatch.setenv('GOOGLE_API_KEY', 'test-key')
    from langchain_google_genai import ChatGoogleGenerativeAI
    canvas = Canvas(revision=1, page_id='page:main', shapes=[])
    session = SimpleNamespace(canvas=canvas, pending={}, board='realgraph', storage=Storage(tmp_path/'graph.db'))
    events = []
    async def send(event):
        events.append(event)
        if event['type'] == 'actions':
            if accepted:
                session.canvas = session.canvas.model_copy(update={'revision': session.canvas.revision + 1,
                    'shapes': session.canvas.shapes + [{'id': op['id']} for op in event['operations']]})
            session.pending[event['batch_id']].set_result({'ok': accepted})
    session.send = send
    request = ChatRequest(type='chat', request_id='structured', message='Draw detailed diagram', canvas=canvas)
    planner = AsyncMock()
    planner.ainvoke.return_value = {
        'operations': [{'op': 'create_shape', 'id': f'shape:n{i}'} for i in range(54)],
        'explanation': 'Draw full diagram', 'answer': 'The requested boxes are ready.',
    }
    with patch.object(ChatGoogleGenerativeAI, 'with_structured_output', return_value=planner), \
         patch.object(ChatGoogleGenerativeAI, '_agenerate', side_effect=AssertionError('Native model transport must not run')):
        if accepted:
            answer = asyncio.run(run_agent(session, request, []))
            assert answer.startswith('Canvas changes applied.')
        else:
            with pytest.raises(RuntimeError, match='canvas_plan_not_applied'):
                asyncio.run(run_agent(session, request, []))
    assert [len(e['operations']) for e in events if e['type'] == 'actions'] == ([40, 14] if accepted else [40])
    assert planner.ainvoke.await_count == 1
    assert len(session.canvas.shapes) == (54 if accepted else 0)
    assert session.pending == {}


@pytest.mark.parametrize('reject_second', [False, True])
def test_large_plan_is_prevalidated_and_acknowledged_in_bounded_batches(tmp_path, monkeypatch, reject_second):
    monkeypatch.setenv('GOOGLE_API_KEY', 'test-key')
    canvas = Canvas(revision=1, page_id='page:main', shapes=[])
    session = SimpleNamespace(canvas=canvas, pending={}, board='board', storage=Storage(tmp_path/'large.db'))
    batches = []
    async def send(event):
        if event['type'] != 'actions':
            return
        batches.append(event)
        assert event['revision'] == session.canvas.revision
        assert len(session.pending) == 1
        batch = EditBatch(operations=event['operations'], explanation=event['explanation'])
        validate_targets(batch, session.canvas)
        ok = not (reject_second and len(batches) == 2)
        if ok:
            session.canvas = session.canvas.model_copy(update={'revision': session.canvas.revision + 1,
                'shapes': session.canvas.shapes + [{'id': o.id} for o in batch.operations]})
        session.pending[event['batch_id']].set_result({'ok': ok})
    session.send = send
    request = ChatRequest(type='chat', request_id='large', message='Draw complete diagram', canvas=canvas)
    operations = [{'op': 'create_shape', 'id': f'shape:n{i}'} for i in range(45)]
    operations += [{'op': 'create_arrow', 'id': f'shape:e{i}', 'from_id': f'shape:n{i}',
                    'to_id': f'shape:n{i+1}'} for i in range(40)]
    def factory(**kwargs):
        edit = next(t for t in kwargs['tools'] if t.name == 'edit_canvas')
        assert edit.args_schema.model_json_schema()['properties']['operations']['maxItems'] == 120
        class Graph:
            async def astream(self, *args, **kw):
                result = await edit.ainvoke({'operations': operations, 'explanation': 'Full diagram'})
                assert ('false' if reject_second else 'true') in result
                yield 'values', {'messages': [AIMessage(content='Stopped.' if reject_second else 'Done.')]}
        return Graph()
    with patch('backend.agent.ChatGoogleGenerativeAI'), patch('backend.agent.create_deep_agent', side_effect=factory):
        asyncio.run(run_agent(session, request, []))
    assert [len(b['operations']) for b in batches] == ([40, 40] if reject_second else [40, 40, 5])
    assert len(session.canvas.shapes) == (40 if reject_second else 85)
    assert session.pending == {}


def test_recovery_accepts_54_operations_and_checks_all_targets_before_dispatch():
    model = MagicMock()
    planner = AsyncMock()
    model.with_structured_output.return_value = planner
    ops = [{'op': 'create_shape', 'id': f'shape:n{i}'} for i in range(40)]
    ops += [{'op': 'create_arrow', 'id': f'shape:e{i}', 'from_id': f'shape:n{i}',
             'to_id': f'shape:n{i+1}'} for i in range(14)]
    planner.ainvoke.return_value = {'operations': ops, 'explanation': 'Full diagram', 'answer': 'Explanation'}
    apply_plan = AsyncMock()
    apply_plan.ainvoke.return_value = '{"ok":true}'
    canvas = Canvas(revision=1, page_id='page:main', shapes=[])
    asyncio.run(recover_canvas_plan(model, [], canvas, apply_plan))
    assert len(apply_plan.ainvoke.call_args.args[0]['operations']) == 54
    apply_plan.reset_mock()
    ops[-1]['to_id'] = 'shape:missing'
    with pytest.raises(RuntimeError, match='invalid_canvas_plan'):
        asyncio.run(recover_canvas_plan(model, [], canvas, apply_plan))
    apply_plan.ainvoke.assert_not_called()


def test_normalizes_gemini_node_and_text_ids_consistently_before_arrow_validation():
    model = MagicMock()
    planner = AsyncMock()
    model.with_structured_output.return_value = planner
    planner.ainvoke.return_value = {'operations': [
        {'op': 'create_shape', 'id': 'node:encoder', 'text': 'Encoder'},
        {'op': 'add_text', 'id': 'text:description', 'text': 'Explanation'},
        {'op': 'create_arrow', 'id': 'edge:encoder-note', 'from_id': 'node:encoder', 'to_id': 'text:description'},
    ], 'explanation': 'Create labeled nodes', 'answer': 'Diagram ready.'}
    apply_plan = AsyncMock()
    apply_plan.ainvoke.return_value = '{"ok":true}'
    asyncio.run(recover_canvas_plan(model, [], Canvas(revision=1, page_id='page:main', shapes=[]), apply_plan))
    ops = apply_plan.ainvoke.call_args.args[0]['operations']
    assert [op['id'] for op in ops] == ['shape:node_encoder', 'shape:text_description', 'shape:edge_encoder-note']
    assert (ops[2]['from_id'], ops[2]['to_id']) == ('shape:node_encoder', 'shape:text_description')


def test_validation_correction_happens_before_any_dispatch():
    model = MagicMock()
    planner = AsyncMock()
    model.with_structured_output.return_value = planner
    bad = {'operations': [{'op': 'create_shape', 'id': 'shape:new', 'x': 100001}],
           'explanation': 'Box', 'answer': 'Done'}
    good = {**bad, 'operations': [{'op': 'create_shape', 'id': 'shape:new', 'x': 100}]}
    planner.ainvoke.side_effect = [bad, good]
    apply_plan = AsyncMock()
    apply_plan.ainvoke.return_value = '{"ok":true}'
    asyncio.run(recover_canvas_plan(model, [], Canvas(revision=1, page_id='page:main', shapes=[]), apply_plan))
    assert planner.ainvoke.await_count == 2
    assert apply_plan.ainvoke.await_count == 1
    assert 'Validation errors' in planner.ainvoke.call_args.args[0][-1].content


def test_recovery_validates_provider_plan_before_dispatch():
    model = MagicMock()
    planner = AsyncMock()
    model.with_structured_output.return_value = planner
    planner.ainvoke.return_value = {'operations': [{'op': 'create_shape', 'id': 'shape:new', 'x': 100001}],
                                  'explanation': 'Invalid coordinate', 'answer': 'Plan'}
    apply_plan = AsyncMock()
    with pytest.raises(ValidationError):
        asyncio.run(recover_canvas_plan(model, [], Canvas(revision=1, page_id='page:main', shapes=[]), apply_plan))
    apply_plan.ainvoke.assert_not_called()


@pytest.mark.parametrize('ok', [True, False])
def test_structured_recovery_requires_browser_ack(tmp_path, monkeypatch, ok):
    monkeypatch.setenv('GOOGLE_API_KEY', 'test-key')
    canvas = Canvas(revision=1, page_id='page:main', shapes=[{'id': 'shape:existing'}])
    session = SimpleNamespace(canvas=canvas, pending={}, board='board', storage=Storage(tmp_path/'plan.db'))
    edits = []
    async def send(event):
        if event['type'] == 'actions':
            edits.append(event)
            session.pending[event['batch_id']].set_result({'ok': ok})
    session.send = send
    request = ChatRequest(type='chat', request_id='plan', message='Draw transformer', canvas=canvas)
    class BrokenGraph:
        async def astream(self, *args, **kwargs):
            yield 'values', {'messages': [AIMessage(content='', response_metadata={'finish_reason': 'MALFORMED_FUNCTION_CALL'})]}
    planner = AsyncMock()
    planner.ainvoke.return_value = {'operations': [{'op': 'create_shape', 'id': 'shape:new'}],
                                  'explanation': 'Add box', 'answer': 'Attention combines values using query-key weights.'}
    with patch('backend.agent.ChatGoogleGenerativeAI') as model, patch('backend.agent.create_deep_agent', return_value=BrokenGraph()):
        model.return_value.with_structured_output.return_value = planner
        if ok:
            assert asyncio.run(run_agent(session, request, [])) .startswith('Canvas changes applied.')
        else:
            with pytest.raises(RuntimeError, match='canvas_plan_not_applied'):
                asyncio.run(run_agent(session, request, []))
        assert model.return_value.with_structured_output.call_args.kwargs['method'] == 'json_schema'
    assert len(edits) == 1
    assert session.pending == {}


@pytest.mark.parametrize('reason', ['MAX_TOKENS', 'STOP'])
def test_incomplete_response_recovers_before_edits(tmp_path, monkeypatch, reason):
    monkeypatch.setenv('GOOGLE_API_KEY', 'test-key')
    canvas = Canvas(revision=1, page_id='page:main', shapes=[])
    events = []
    session = SimpleNamespace(canvas=canvas, pending={}, board='board', storage=Storage(tmp_path/'recovery.db'))
    async def send(event):
        events.append(event)
    session.send = send
    request = ChatRequest(type='chat', request_id='retry', message='Draw transformer', canvas=canvas)
    attempts = []
    def factory(**kwargs):
        attempt = len(attempts)
        attempts.append(kwargs)
        class Graph:
            async def astream(self, state, **kw):
                if attempt == 0:
                    # Earlier planning text must not be mistaken for the final result.
                    yield 'values', {'messages': [AIMessage(content='Planning the diagram')]}
                    yield 'values', {'messages': [AIMessage(content='', response_metadata={'finish_reason': reason})]}
                else:
                    assert 'at most 4 operations' in state['messages'][-1].content
                    yield 'values', {'messages': [AIMessage(content='Recovered response')]}
        return Graph()
    with patch('backend.agent.ChatGoogleGenerativeAI') as model, patch('backend.agent.create_deep_agent', side_effect=factory):
        assert asyncio.run(run_agent(session, request, [])) == 'Recovered response'
    assert len(attempts) == 2
    assert model.call_args_list[1].kwargs['disable_streaming'] == 'tool_calling'
    assert any(e['type'] == 'status' for e in events)


@pytest.mark.parametrize('ack_ok', [True, False])
def test_malformed_response_after_edit_continues_only_confirmed_work(tmp_path, monkeypatch, ack_ok):
    monkeypatch.setenv('GOOGLE_API_KEY', 'test-key')
    canvas = Canvas(revision=1, page_id='page:main', shapes=[])
    session = SimpleNamespace(canvas=canvas, pending={}, board='board', storage=Storage(tmp_path/'partial.db'))
    edits = []
    async def send(event):
        if event['type'] == 'actions':
            edits.append(event)
            if ack_ok:
                session.canvas = canvas.model_copy(update={'revision': 2, 'shapes': [{'id': 'shape:one', 'text': 'Input'}]})
            session.pending[event['batch_id']].set_result({'ok': ack_ok})
    session.send = send
    request = ChatRequest(type='chat', request_id='partial', message='Draw transformer', canvas=canvas)
    def factory(**kwargs):
        edit = next(t for t in kwargs['tools'] if t.name == 'edit_canvas')
        class Graph:
            async def astream(self, *args, **kw):
                await edit.ainvoke({'operations': [{'op': 'create_shape', 'id': 'shape:one'}], 'explanation': 'Input'})
                yield 'values', {'messages': [AIMessage(content='', response_metadata={'finish_reason': 'MALFORMED_FUNCTION_CALL'})]}
        return Graph()
    planner = AsyncMock()
    async def plan(messages, **kwargs):
        assert 'shape:one' in messages[-1].content
        assert 'Already confirmed operations' in messages[-1].content
        assert '"revision":2' in messages[-1].content
        return {'operations': [{'op': 'create_shape', 'id': 'shape:two'},
                               {'op': 'create_arrow', 'id': 'shape:link', 'from_id': 'shape:one', 'to_id': 'shape:two'}],
                'explanation': 'Complete remaining diagram', 'answer': 'Completed connections.'}
    planner.ainvoke.side_effect = plan
    with patch('backend.agent.ChatGoogleGenerativeAI') as model, patch('backend.agent.create_deep_agent', side_effect=factory) as graph:
        model.return_value.with_structured_output.return_value = planner
        if ack_ok:
            assert asyncio.run(run_agent(session, request, [])).startswith('Canvas changes applied.')
        else:
            with pytest.raises(RuntimeError, match='invalid_model_tool_call'):
                asyncio.run(run_agent(session, request, []))
            planner.ainvoke.assert_not_called()
    assert graph.call_count == 1
    assert len(edits) == (2 if ack_ok else 1)
    assert sum(op['id'] == 'shape:one' for edit in edits for op in edit['operations']) == 1
    assert session.pending == {}


def test_agent_waits_for_ack_and_detects_changed_canvas(tmp_path,monkeypatch):
    monkeypatch.setenv('GOOGLE_API_KEY','test-key')
    canvas=Canvas(revision=1,page_id='page:main',shapes=[])
    events=[]
    session=SimpleNamespace(canvas=canvas,pending={},board='board',storage=Storage(tmp_path/'agent.db'))
    async def send(event):
        events.append(event)
        if event['type']=='actions':
            assert not session.pending[event['batch_id']].done()
            session.canvas=canvas.model_copy(update={'revision':3,'shapes':[{'id':'shape:one'}]})
            session.pending[event['batch_id']].set_result({'ok':True,'revision':3})
    session.send=send
    request=ChatRequest(type='chat',request_id='one',message='draw',canvas=canvas.model_copy(deep=True))

    def factory(**kwargs):
        tools={t.name:t for t in kwargs['tools']}
        class Graph:
            async def astream(self,*args,**kw):
                session.canvas=canvas.model_copy(update={'revision':2})
                result=await tools['edit_canvas'].ainvoke({'operations':[{'op':'create_shape','id':'shape:one'}],'explanation':'Add rectangle'})
                assert 'changed' in result
                assert not any(e['type']=='actions' for e in events)
                await tools['read_canvas'].ainvoke({})
                result=await tools['edit_canvas'].ainvoke({'operations':[{'op':'create_shape','id':'shape:one'}],'explanation':'Add rectangle'})
                assert 'true' in result
                from langchain_core.messages import AIMessage
                yield 'values',{'messages':[AIMessage(content='Added a rectangle.')]}
        return Graph()
    with patch('backend.agent.ChatGoogleGenerativeAI'),patch('backend.agent.create_deep_agent',side_effect=factory):
        answer=asyncio.run(run_agent(session,request,[]))
    assert answer=='Added a rectangle.'
    assert len([e for e in events if e['type']=='actions'])==1
    assert session.pending=={}
