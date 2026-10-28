"""Isolated SQLite execution plus PostgreSQL SQL compilation; no provider calls.

SQLite test compilers translate only pgvector's distance operator/cast to a local
cosine function, so the production query composition and ranking run unchanged.
"""
import hashlib
import json
import math
import os
from datetime import UTC, date, datetime
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.dialects import postgresql
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.compiler import compiles, deregister
from sqlalchemy.orm import Session
from sqlalchemy.sql.elements import BinaryExpression, Cast

from app.query_plan import KeywordMatch, QueryPlan, SemanticMatch
from app.services import embedding, query_router, retrieval_tools


def plan(*operations, questions=None):
    return {'version': '1', 'operations': list(operations), 'clarification_questions': questions or []}


def filt(field, operator, value):
    return {'operation': 'filter', 'field': field, 'operator': operator, 'value': value}


def sort(field, direction='asc'):
    return {'operation': 'sort', 'field': field, 'direction': direction, 'nulls': 'last'}


def limit(count):
    return {'operation': 'limit', 'count': count}


def keyword(query):
    return {'operation': 'keyword_match', 'query': query}


def semantic(query):
    return {'operation': 'semantic_match', 'query': query}


def vector(x=1.0, y=0.0):
    return json.dumps([x, y] + [0.0] * (embedding.DIMENSIONS - 2))


@pytest.fixture(autouse=True)
def no_provider(monkeypatch):
    monkeypatch.setattr(embedding, 'generate_embedding', Mock(side_effect=AssertionError('Real embedding call forbidden')))


@pytest.fixture
def store(monkeypatch):
    # Only the model module needs configuration; this engine is always separate,
    # in-memory, and disposable, regardless of the user's configured DATABASE_URL.
    if not os.getenv('DATABASE_URL'):
        monkeypatch.setenv('DATABASE_URL', 'sqlite+pysqlite:///:memory:')
    from app import config
    from app.models import EmbeddingVector, Memory

    monkeypatch.setattr(config, 'LOCAL_USER_ID', 'local-dev-user')

    @compiles(BinaryExpression, 'sqlite')
    def compile_binary(element, compiler, **kw):
        if getattr(element.operator, 'opstring', None) == '<=>':
            return f'cosine_distance({compiler.process(element.left, **kw)}, {compiler.process(element.right, **kw)})'
        return compiler.visit_binary(element, **kw)

    @compiles(Cast, 'sqlite')
    def compile_cast(element, compiler, **kw):
        if isinstance(element.type, EmbeddingVector):
            return compiler.process(element.clause, **kw)
        return compiler.visit_cast(element, **kw)

    engine = create_engine('sqlite+pysqlite:///:memory:')

    @event.listens_for(engine, 'connect')
    def add_distance(connection, record):
        def cosine_distance(left, right):
            a, b = json.loads(left), json.loads(right)
            return 1 - sum(x * y for x, y in zip(a, b)) / (math.hypot(*a) * math.hypot(*b))
        connection.create_function('cosine_distance', 2, cosine_distance)

    Memory.__table__.create(engine)
    with Session(engine) as db:
        def add(title='Memory', indexed=False, **values):
            fields = {'user_id': 'local-dev-user', 'title': title, 'original_text': 'unreviewed private original',
                          'confirmed_content': 'Reviewed content', 'category': 'event', 'tags': '[]',
                          'confirmation_status': 'confirmed', 'source_type': 'manual',
                          'created_at': datetime(2026, 1, 1, tzinfo=UTC),
                          'updated_at': datetime(2026, 1, 1, tzinfo=UTC)}
            fields.update(values)
            memory = Memory(**fields)
            db.add(memory)
            db.flush()
            db.refresh(memory)
            if indexed:
                memory.embedding = vector()
                memory.embedding_model = embedding.MODEL
                memory.embedding_dimensions = embedding.DIMENSIONS
                memory.embedding_status = 'completed'
                memory.embedding_text_hash = hashlib.sha256(embedding.build_embedding_text(memory).encode()).hexdigest()
            db.commit()
            return memory
        yield SimpleNamespace(db=db, add=add, Memory=Memory)
    engine.dispose()
    deregister(BinaryExpression)
    deregister(Cast)


def ids(result):
    return [m.memory_id for m in result.memories]


def execute(store, *operations):
    return query_router.execute_query_plan(plan(*operations), store.db)


def test_date_filters_and_chronological_sort(store):
    late = store.add('Later', event_date=date(2026, 12, 1))
    early = store.add('Earlier', event_date=date(2026, 10, 30))
    store.add('Past', event_date=date(2025, 1, 1))
    store.add('Unknown date')
    result = execute(store, filt('event_date', 'gte', '2026-10-29'), sort('event_date'))
    assert result.status == 'completed'
    assert ids(result) == [early.id, late.id]
    assert result.memories[0].event_date == date(2026, 10, 30)


@pytest.mark.parametrize('field', ['event_date', 'due_date'])
def test_inclusive_date_range(store, field):
    first = store.add('First', **{field: date(2025, 1, 1)})
    last = store.add('Last', **{field: date(2025, 12, 31)})
    store.add('Outside', **{field: date(2026, 1, 1)})
    assert ids(execute(store, filt(field, 'gte', '2025-01-01'), filt(field, 'lte', '2025-12-31'), sort(field))) == [first.id, last.id]


def test_amount_numeric_sort_and_currency_filter(store):
    store.add('Hundred', amount=Decimal('100.00'), currency='NZD')
    cheap = store.add('Twenty', amount=Decimal('20.00'), currency='NZD')
    store.add('Different currency', amount=Decimal('5.00'), currency='USD')
    store.add('Missing amount', currency='NZD')
    result = execute(store, filt('currency', 'eq', 'NZD'), filt('amount', 'lt', '100'), sort('amount'))
    assert ids(result) == [cheap.id]
    assert result.memories[0].amount == Decimal('20.00')


@pytest.mark.parametrize('direction, expected', [('asc', ['Twenty', 'Hundred', 'Missing']), ('desc', ['Hundred', 'Twenty', 'Missing'])])
def test_numeric_sort_nulls_last(store, direction, expected):
    store.add('Hundred', amount=Decimal('100.00'))
    store.add('Missing')
    store.add('Twenty', amount=Decimal('20.00'))
    assert [m.title for m in execute(store, sort('amount', direction)).memories] == expected


@pytest.mark.parametrize('operator, value, expected', [
    ('eq', '20', ['Twenty']), ('ne', '20', ['Hundred']),
    ('gt', '20', ['Hundred']), ('gte', '20', ['Hundred', 'Twenty']),
    ('lt', '100', ['Twenty']), ('lte', '20', ['Twenty']),
    ('is_null', None, ['Missing']), ('is_not_null', None, ['Hundred', 'Twenty']),
])
def test_amount_operators_and_nulls(store, operator, value, expected):
    store.add('Hundred', amount=Decimal('100.00'))
    store.add('Twenty', amount=Decimal('20.00'))
    store.add('Missing')
    assert [m.title for m in execute(store, filt('amount', operator, value)).memories] == expected


def test_reminder_timestamp_filter(store):
    future = store.add('Reminder', reminder_at=datetime(2026, 12, 1, 10, tzinfo=UTC))
    store.add('No reminder')
    assert ids(execute(store, filt('reminder_at', 'gte', '2026-12-01T00:00:00+00:00'), sort('reminder_at'))) == [future.id]


@pytest.mark.parametrize('field', ['title', 'confirmed_content', 'confirmed_image_text', 'category', 'tags'])
def test_keyword_matches_confirmed_fields_case_insensitively(store, field):
    value = '["Spark"]' if field == 'tags' else 'Spark'
    match = store.add(**{field: value})
    store.add('Not a match')
    result = execute(store, keyword('sPaRk'))
    assert ids(result) == [match.id]
    assert result.retrieval_method == ['structured_search', 'keyword_search']


def test_keyword_does_not_match_original_or_draft_fields(store):
    store.add('Reviewed', original_text='Spark', vision_draft='Spark', generated_content='Spark', image_text_draft='Spark')
    assert execute(store, keyword('Spark')).status == 'no_matches'


@pytest.mark.parametrize('query', ['100%', 'under_score', "x' OR 1=1 --", 'back\\slash'])
def test_literal_text_matching_and_parameterization(store, query):
    match = store.add(query)
    store.add('Unrelated')
    assert ids(execute(store, keyword(query))) == [match.id]
    assert ids(execute(store, filt('title', 'contains', query))) == [match.id]
    statement = retrieval_tools.keyword_search(retrieval_tools.structured_search([], []), KeywordMatch(**keyword(query)))
    compiled = statement.compile(dialect=postgresql.dialect())
    assert query not in str(compiled)
    assert retrieval_tools._literal_pattern(query) in compiled.params.values()


def test_owner_and_confirmation_isolation(store):
    owned = store.add('Owned')
    accepted = store.add('Accepted', confirmation_status='accepted')
    store.add('Other owner', user_id='other')
    for status in ['draft', 'rejected', 'unknown']:
        store.add(status, confirmation_status=status)
    result = execute(store, sort('title'))
    assert set(ids(result)) == {owned.id, accepted.id}


def test_operation_order_and_limit_after_filters(store):
    store.add('Unrelated', category='bill', event_date=date(2026, 10, 29))
    later = store.add('Later', event_date=date(2026, 12, 1))
    earlier = store.add('Earlier', event_date=date(2026, 11, 1))
    result = execute(store, limit(1), sort('event_date'), filt('category', 'eq', 'event'))
    assert ids(result) == [earlier.id]
    assert [op['operation'] for op in result.applied_operations] == ['filter', 'sort', 'limit']
    assert later.id not in ids(result)


def test_multiple_limits_sort_priority_and_deterministic_ties(store):
    first = store.add('A', amount=Decimal(10))
    second = store.add('A', amount=Decimal(10))
    store.add('Z', amount=Decimal(10))
    store.add('B', amount=Decimal(5))
    result = execute(store, limit(3), sort('amount', 'desc'), sort('title'), limit(2))
    assert ids(result) == [first.id, second.id]


def test_multiple_keywords_are_intersected(store):
    match = store.add('Spark insurance')
    store.add('Spark alone')
    assert ids(execute(store, keyword('Spark'), keyword('insurance'))) == [match.id]


def test_empty_results_and_uncertain_date_not_inferred(store):
    store.add('Uncertain legacy date', confirmed_vision=json.dumps({'date': '2026-12-01', 'uncertain_fields': ['date']}))
    result = execute(store, filt('event_date', 'gte', '2026-10-29'))
    assert result.status == 'no_matches' and result.memories == [] and result.error is None


def test_source_and_citation_content(store):
    memory = store.add('Receipt', source_type='image', source_image_path='uploads/private-path.png', confirmed_image_text='Reviewed receipt')
    result = execute(store, limit(1))
    match = result.memories[0]
    assert match.citation == f'[Memory {memory.id}]'
    assert match.memory_url == f'/memories/{memory.id}'
    assert match.source_image_url == f'/memories/{memory.id}/image/file'
    serialized = result.model_dump_json()
    assert 'Reviewed receipt' in serialized
    assert 'private-path' not in serialized and 'unreviewed private original' not in serialized


def test_semantic_retrieval_ranking_and_threshold(store, monkeypatch):
    best = store.add('Best', indexed=True)
    middle = store.add('Middle', indexed=True, embedding=vector(0.6, 0.8))
    # Set vectors after add because indexed fixture intentionally fills them.
    middle.embedding = vector(0.6, 0.8)
    weak = store.add('Weak', indexed=True)
    weak.embedding = vector(0.1, 0.99)
    store.db.commit()
    monkeypatch.setattr(embedding, 'generate_embedding', Mock(return_value=vector()))
    result = execute(store, semantic('relevant content'))
    assert ids(result) == [best.id, middle.id]
    assert result.memories[0].relevance == pytest.approx(1)
    assert result.memories[1].relevance == pytest.approx(0.6)
    embedding.generate_embedding.assert_called_once_with('relevant content')


@pytest.mark.parametrize('change', [
    {'embedding': None}, {'embedding_status': 'failed'}, {'embedding_model': 'old'},
    {'embedding_dimensions': 100}, {'embedding_text_hash': 'stale'},
    {'confirmed_content': 'Changed after indexing'},
])
def test_embedding_validity_is_preserved(store, monkeypatch, change):
    good = store.add('Good', indexed=True)
    bad = store.add('Bad', indexed=True)
    for key, value in change.items():
        setattr(bad, key, value)
    store.db.commit()
    monkeypatch.setattr(embedding, 'generate_embedding', Mock(return_value=vector()))
    assert ids(execute(store, semantic('content'))) == [good.id]


def test_semantic_filters_before_ranking_no_fixed_top_k(store, monkeypatch):
    for i in range(8):
        store.add(f'Irrelevant bill {i}', category='bill', indexed=True)
    wanted = store.add('Wanted Spark event', indexed=True, event_date=date(2026, 12, 1))
    store.add('Other owner', user_id='other', indexed=True)
    store.add('Draft', confirmation_status='draft', indexed=True)
    monkeypatch.setattr(embedding, 'generate_embedding', Mock(return_value=vector()))
    result = execute(store, limit(1), semantic('event'), keyword('Spark'),
                     filt('category', 'eq', 'event'), filt('event_date', 'gte', '2026-10-29'), sort('event_date'))
    assert ids(result) == [wanted.id]
    assert [op['operation'] for op in result.applied_operations] == ['filter', 'filter', 'keyword_match', 'semantic_match', 'sort', 'limit']


def test_semantic_has_no_implicit_five_result_cap(store, monkeypatch):
    expected = [store.add(f'Match {i}', indexed=True).id for i in range(8)]
    monkeypatch.setattr(embedding, 'generate_embedding', Mock(return_value=vector()))
    assert ids(execute(store, semantic('content'))) == expected


def test_explicit_sort_overrides_similarity(store, monkeypatch):
    store.add('Expensive', indexed=True, amount=Decimal(100))
    cheap = store.add('Cheap', indexed=True, amount=Decimal(10))
    cheap.embedding = vector(0.6, 0.8)
    store.db.commit()
    monkeypatch.setattr(embedding, 'generate_embedding', Mock(return_value=vector()))
    assert ids(execute(store, semantic('content'), sort('amount'), limit(1))) == [cheap.id]


def test_multiple_semantic_matches_intersect_and_rank_mean_score(store, monkeypatch):
    balanced = store.add('Balanced', indexed=True)
    balanced.embedding = vector(0.7, 0.7)
    specialist = store.add('Specialist', indexed=True)
    specialist.embedding = vector(0.95, 0.3)
    excluded = store.add('Excluded', indexed=True)
    store.db.commit()
    monkeypatch.setattr(embedding, 'generate_embedding', Mock(side_effect=[vector(), vector(0, 1)]))
    result = execute(store, semantic('first'), semantic('second'))
    assert ids(result) == [balanced.id, specialist.id]
    assert excluded.id not in ids(result)


def test_no_indexed_candidates_skips_embedding_call(store):
    store.add('Unindexed')
    assert execute(store, semantic('content')).status == 'no_matches'
    embedding.generate_embedding.assert_not_called()


def test_semantic_sql_is_parameterized_and_owner_scoped(store, monkeypatch):
    store.add('Valid', indexed=True)
    monkeypatch.setattr(embedding, 'generate_embedding', Mock(return_value=vector()))
    statement, _score = retrieval_tools.semantic_search(store.db, retrieval_tools.structured_search([], []), SemanticMatch(**semantic('content')))
    compiled = statement.compile(dialect=postgresql.dialect())
    sql = str(compiled)
    assert '<=>' in sql and 'vector(1536)' in sql
    assert 'LIMIT' not in sql
    assert 'memories.user_id' in sql and 'memories.confirmation_status' in sql
    assert vector() in compiled.params.values()
    assert vector() not in sql


@pytest.mark.parametrize('value, status, unsupported', [
    (plan(questions=['Which date?']), 'needs_clarification', []),
    (plan({'operation': 'aggregate', 'function': 'sum', 'field': 'amount'}), 'requires_future_tools', ['aggregate']),
    (plan({'operation': 'calculate_distance', 'field': 'location', 'origin': 'Hamilton', 'unit': 'km', 'order': 'asc'}), 'requires_future_tools', ['calculate_distance']),
    (plan({'operation': 'convert_currency', 'field': 'amount', 'source_currency': None, 'target_currency': 'NZD', 'rate_date': '2026-10-29'}), 'requires_future_tools', ['convert_currency']),
    (plan({'operation': 'calculate_distance', 'field': 'location', 'origin': None, 'unit': 'km', 'order': 'asc'}, questions=['Where are you?']), 'needs_clarification', ['calculate_distance']),
])
def test_preflight_blocks_without_touching_db(value, status, unsupported):
    db = Mock()
    result = query_router.execute_query_plan(value, db)
    assert result.status == status and result.unsupported_capabilities == unsupported
    assert result.memories == [] and result.applied_operations == []
    assert result.clarification_questions == value['clarification_questions']
    assert db.mock_calls == []


@pytest.mark.parametrize('value', [None, {}, plan(filt('user_id', 'eq', 'other')), plan(limit(-1)), plan({'operation': 'sql', 'query': 'SELECT *'}), plan(filt('amount', 'gt', 'NaN'))])
def test_invalid_plan_never_touches_db(value):
    db = Mock()
    result = query_router.execute_query_plan(value, db)
    assert result.status == 'invalid_plan' and result.error.code == 'invalid_plan'
    assert db.mock_calls == []


def test_mutated_model_revalidated():
    value = QueryPlan.model_validate(plan(limit(1)))
    value.operations[0].count = -1
    assert query_router.execute_query_plan(value, Mock()).status == 'invalid_plan'


def test_semantic_failure_does_not_fallback_or_leak(store, monkeypatch):
    store.add('Valid', indexed=True)
    monkeypatch.setattr(embedding, 'generate_embedding', Mock(side_effect=ValueError('private-provider-secret')))
    result = execute(store, keyword('Valid'), semantic('content'))
    assert result.status == 'execution_failed' and result.error.code == 'semantic_unavailable'
    assert result.memories == [] and result.applied_operations == []
    assert 'private-provider-secret' not in result.model_dump_json()


def test_database_failure_is_sanitized(store, monkeypatch):
    monkeypatch.setattr(store.db, 'execute', Mock(side_effect=OperationalError('private SQL', {}, Exception('secret'))))
    result = execute(store, limit(1))
    assert result.status == 'execution_failed' and result.error.code == 'database_error'
    assert 'secret' not in result.model_dump_json()


def test_unexpected_retrieval_failure_is_sanitized(store, monkeypatch):
    monkeypatch.setattr(retrieval_tools, 'structured_search', Mock(side_effect=RuntimeError('secret')))
    result = execute(store, limit(1))
    assert result.error.code == 'retrieval_failed' and result.memories == []


def test_read_only_execution_does_not_flush_or_commit_pending_records(store):
    store.add('Saved')
    store.db.add(store.Memory(user_id='local-dev-user', title='Pending', original_text='x', confirmed_content='x'))
    statements = []
    @event.listens_for(store.db.get_bind(), 'before_cursor_execute')
    def capture(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)
    result = execute(store, limit(10))
    assert [m.title for m in result.memories] == ['Saved']
    assert all(statement.lstrip().upper().startswith('SELECT') for statement in statements)
    assert len(store.db.new) == 1


def test_semantic_owner_and_confirmation_isolation(store, monkeypatch):
    owned = store.add('Owned', indexed=True)
    accepted = store.add('Accepted', indexed=True, confirmation_status='accepted')
    store.add('Other', indexed=True, user_id='other')
    store.add('Draft', indexed=True, confirmation_status='draft')
    store.add('Unknown', indexed=True, confirmation_status='unknown')
    monkeypatch.setattr(embedding, 'generate_embedding', Mock(return_value=vector()))
    assert ids(execute(store, semantic('content'))) == [owned.id, accepted.id]


def test_database_error_during_semantic_search_is_not_embedding_error(store, monkeypatch):
    monkeypatch.setattr(store.db, 'scalars', Mock(side_effect=OperationalError('SQL', {}, Exception('secret'))))
    result = execute(store, semantic('content'))
    assert result.status == 'execution_failed' and result.error.code == 'database_error'
    assert result.memories == [] and result.applied_operations == []


@pytest.fixture
def regression_api(store, monkeypatch):
    from app.query_plan import QueryPlan
    from app.routes import query
    from app.services import query_conversation, vision

    calls = []
    configured = {'plan': None}
    def request(payload, output_model):
        data = json.loads(payload['input'][0]['content'][0]['text'])
        calls.append((output_model, data))
        if output_model is QueryPlan:
            return {'draft': configured['plan']}
        memories = data['memories']
        assert memories
        memory_id = memories[0]['memory_id']
        return {'draft': {'answer': f"Supported answer [Memory {memory_id}]", 'memory_ids': [memory_id]}}
    monkeypatch.setattr(vision, '_request', request)
    def ask(question, **values):
        return query.query_memories(query.MemoryQuestion(question=question, consent=True,
                                    today=date(2026, 10, 29), **values), store.db)
    yield SimpleNamespace(ask=ask, configured=configured, calls=calls)
    query_conversation._pending.clear()


def test_regression_next_event_uses_legacy_date_before_limits(store, regression_api):
    fete = store.add('Hanmer Springs Fete', category='notice', confirmation_status='accepted',
                     confirmed_vision=json.dumps({'date': '2026-10-31'}))
    store.add('Later event', event_date=date(2026, 11, 10))
    store.add('Other owner earlier', user_id='other', event_date=date(2026, 10, 30))
    store.add('Draft earlier', confirmation_status='draft', event_date=date(2026, 10, 30))
    regression_api.configured['plan'] = plan(filt('category', 'eq', 'event'),
        semantic('a forthcoming social gathering'), filt('event_date', 'gte', '2026-10-29'), sort('event_date'), limit(1))
    response = regression_api.ask('What is my next upcoming event?')
    assert response['status'] == 'completed'
    assert response['sources'][0]['memory_id'] == fete.id
    assert response['sources'][0]['event_date'] == '2026-10-31'
    assert response['sources'][0]['citation'] == f'[Memory {fete.id}]'
    assert regression_api.calls[-1][1]['memories'][0]['event_date'] == '2026-10-31'
    embedding.generate_embedding.assert_not_called()
    # Explicit API category filters remain strict; only speculative model filters
    # are normalized. This intentionally selects the later typed event instead.
    explicit = regression_api.ask('What is my next upcoming event?', category='event')
    assert explicit['sources'][0]['title'] == 'Later event'


@pytest.mark.parametrize('semantic_operation', [True, False])
def test_regression_car_insurance_not_restricted_to_bill_or_exact_phrase(store, regression_api, monkeypatch, semantic_operation):
    policy = store.add('Motor vehicle cover', category='notice', indexed=True,
                       confirmed_content='Comprehensive motor vehicle insurance renewal information')
    operations = [filt('category', 'eq', 'bill'), keyword('car insurance')]
    if semantic_operation:
        operations.append(semantic('car insurance'))
    regression_api.configured['plan'] = plan(*operations)
    monkeypatch.setattr(embedding, 'generate_embedding', Mock(return_value=vector()))
    response = regression_api.ask('What did I save about car insurance?')
    assert response['status'] == 'completed'
    assert response['sources'][0]['memory_id'] == policy.id
    assert response['retrieval_method'] == ['structured_search', 'semantic_search']


def test_regression_location_reply_resumes_original_without_llm_or_retrieval(store, regression_api, monkeypatch):
    from app.services import query_conversation, retrieval_tools
    regression_api.configured['plan'] = plan(filt('event_date', 'gte', '2026-10-29'),
        {'operation': 'calculate_distance', 'field': 'location', 'origin': None, 'unit': 'km', 'order': 'asc'},
        questions=['What is your current location?'])
    first = regression_api.ask('Which upcoming event is closest to me?')
    assert first['status'] == 'needs_clarification' and len(regression_api.calls) == 1
    pending = query_conversation._pending[('local-dev-user', first['conversation_id'])]
    resumed = query_conversation.resume_plan(pending, 'Hamilton')
    assert resumed.operations[-1].origin == 'Hamilton'
    assert resumed.status == 'requires_future_tools'
    monkeypatch.setattr(retrieval_tools, 'structured_search', Mock(side_effect=AssertionError('Must not retrieve')))
    second = regression_api.ask('Hamilton', conversation_id=first['conversation_id'], is_clarification_reply=True)
    assert second['status'] == 'requires_future_tools'
    assert 'nearest location' in second['answer'] and 'calculate_distance' not in second['answer']
    assert second['sources'] == [] and len(regression_api.calls) == 1
    assert not query_conversation._pending


def test_regression_new_question_replaces_pending_clarification(store, regression_api):
    regression_api.configured['plan'] = plan(questions=['What location should I use?'])
    first = regression_api.ask('Which event is closest?')
    regression_api.configured['plan'] = plan(keyword('insurance'))
    second = regression_api.ask('New question: Find my insurance', conversation_id=first['conversation_id'],
                                is_clarification_reply=True)
    assert second['status'] == 'no_matches'
    assert regression_api.calls[-1][1]['question'] == 'Find my insurance'


def test_regression_conversation_and_owner_isolation_and_expiry(monkeypatch):
    from app.query_plan import QueryPlan
    from app.services import query_conversation
    pending_plan = QueryPlan.model_validate(plan(questions=['Where should I start?']))
    query_conversation.save_pending('owner-a', 'conversation-a', {}, pending_plan)
    assert query_conversation.take_pending('owner-b', 'conversation-a') is None
    assert query_conversation.take_pending('owner-a', 'conversation-b') is None
    clock = query_conversation.monotonic()
    monkeypatch.setattr(query_conversation, 'monotonic', lambda: clock + query_conversation.TTL_SECONDS + 1)
    assert query_conversation.take_pending('owner-a', 'conversation-a') is None


def test_regression_expired_followup_is_not_independent_search(regression_api):
    from uuid import uuid4
    response = regression_api.ask('Hamilton', conversation_id=str(uuid4()), is_clarification_reply=True)
    assert response['status'] == 'needs_clarification'
    assert 'expired' in response['answer'] and regression_api.calls == []


def test_regression_clarifications_use_supported_natural_language():
    from app.services.intent_classifier import friendly_question
    assert 'created_at' not in friendly_question('Should I use created_at or event_date?')
    assert 'event_date' not in friendly_question('Should I use created_at or event_date?')
    payment = friendly_question('Should I use payment dates or created_at?')
    assert 'saved' in payment and 'not available separately' in payment


def test_regression_legacy_dates_reject_invalid_uncertain_and_prefer_typed_date(store):
    from app.services.retrieval_tools import event_day
    for value in ['not json', '{}', '{"date":"2026-02-30"}',
                  '{"date":"2026-10-31","uncertain_fields":["date"]}']:
        memory = store.add(confirmed_vision=value)
        assert event_day(memory) is None
    memory = store.add(event_date=date(2026, 11, 1), confirmed_vision='{"date":"2026-10-31"}')
    assert event_day(memory) == date(2026, 11, 1)


def test_regression_insurance_spending_returns_unsupported_not_invalid(regression_api, monkeypatch):
    monkeypatch.setattr(retrieval_tools, 'structured_search', Mock(side_effect=AssertionError('Must not retrieve')))
    response = regression_api.ask('How much did I spend on insurance last year?')
    assert response['status'] == 'requires_future_tools'
    assert response['unsupported_capabilities'] == ['aggregate']
    assert 'calculating totals' in response['answer']
    assert 'could not understand' not in response['answer'].lower()
    assert response['clarification_questions'] == [] and response['sources'] == []
    assert regression_api.calls == []
    embedding.generate_embedding.assert_not_called()


def test_location_hamilton_upcoming_event(store, regression_api):
    match = store.add('Hamilton event', category='notice', location='Garden Place, HAMILTON',
                      confirmed_vision=json.dumps({'date': '2026-10-31'}))
    store.add('Later Hamilton event', location='Hamilton', event_date=date(2026, 11, 5))
    store.add('Auckland earlier', location='Auckland', event_date=date(2026, 10, 30))
    store.add('Past Hamilton event', location='Hamilton', event_date=date(2026, 10, 1))
    store.add('Other owner', user_id='other', location='Hamilton', event_date=date(2026, 10, 30))
    store.add('Draft', confirmation_status='draft', location='Hamilton', event_date=date(2026, 10, 30))
    regression_api.configured['plan'] = plan(
        keyword('Hamilton'), semantic('upcoming event in Hamilton'), filt('category', 'eq', 'event'),
        filt('location', 'contains', 'Hamilton'), filt('event_date', 'gte', '2026-10-29'),
        sort('event_date'), limit(1))
    response = regression_api.ask('What is the next upcoming event in Hamilton?')
    assert response['status'] == 'completed'
    assert [source['memory_id'] for source in response['sources']] == [match.id]
    assert response['sources'][0]['citation'] == f'[Memory {match.id}]'
    assert regression_api.calls[-1][1]['memories'][0]['location'] == 'Garden Place, HAMILTON'
    assert response['retrieval_method'] == ['structured_search']
    embedding.generate_embedding.assert_not_called()


def test_location_auckland_next_month_date_boundaries_and_sort(store, regression_api):
    last = store.add('November end', location='Auckland', event_date=date(2026, 11, 30))
    first = store.add('November start', location='auckland', event_date=date(2026, 11, 1))
    store.add('October', location='Auckland', event_date=date(2026, 10, 31))
    store.add('December', location='Auckland', event_date=date(2026, 12, 1))
    store.add('Unknown date', location='Auckland')
    store.add('Wrong location', location='Wellington', event_date=date(2026, 11, 2))
    regression_api.configured['plan'] = plan(
        filt('location', 'contains', 'Auckland'), filt('event_date', 'gte', '2026-11-01'),
        filt('event_date', 'lt', '2026-12-01'), sort('event_date'))
    response = regression_api.ask('Are there any events in Auckland next month?')
    context = regression_api.calls[-1][1]['memories']
    assert response['status'] == 'completed'
    assert [memory['memory_id'] for memory in context] == [first.id, last.id]
    assert response['matched_count'] == 2
    embedding.generate_embedding.assert_not_called()


def test_location_wellington_all_and_no_matches(store, regression_api):
    match = store.add('Undated Wellington activity', location='Wellington')
    store.add('General content mention', confirmed_content='Someone from Wellington will attend',
              location='Hamilton')
    regression_api.configured['plan'] = plan(filt('location', 'contains', 'Wellington'),
                                            keyword('Wellington'), filt('category', 'eq', 'event'))
    response = regression_api.ask('Show me all events in Wellington.')
    assert response['status'] == 'completed' and response['matched_count'] == 1
    assert response['sources'][0]['memory_id'] == match.id
    assert not any(op['operation'] == 'limit' for op in response['applied_operations'])
    regression_api.configured['plan'] = plan(filt('location', 'contains', 'Dunedin'))
    count_before = len(regression_api.calls)
    empty = regression_api.ask('Show me all events in Dunedin.')
    assert empty['status'] == 'no_matches' and empty['sources'] == []
    assert 'No confirmed Memories match' in empty['answer']
    assert len(regression_api.calls) == count_before + 1  # Classify only, no answer call.
    embedding.generate_embedding.assert_not_called()


def test_location_confirmed_vision_only_excludes_uncertain_and_content(store, regression_api):
    match = store.add('Recorded venue', category='notice',
                      confirmed_vision=json.dumps({'location_name': 'Community Hall',
                                                   'location_address': '123 Example Street, Hamilton'}))
    store.add('Content mention only', confirmed_content='A visitor from Hamilton',
              confirmed_vision=json.dumps({'summary': 'Hamilton', 'location_purpose': 'meet Hamilton visitors'}))
    store.add('Uncertain city', confirmed_vision=json.dumps({'location_name': 'Hamilton',
                                                           'uncertain_fields': ['location_name']}))
    store.add('Draft location', vision_draft=json.dumps({'location_address': 'Hamilton'}))
    store.add('Malformed JSON', confirmed_vision='{invalid')
    regression_api.configured['plan'] = plan(filt('location', 'contains', 'hamilton'))
    response = regression_api.ask('What activities have I saved in Hamilton?')
    assert response['status'] == 'completed' and response['matched_count'] == 1
    assert response['sources'][0]['memory_id'] == match.id
    context = regression_api.calls[-1][1]['memories'][0]
    assert context['location'] == 'Community Hall; 123 Example Street, Hamilton'
    assert context['event_date'] is None
    embedding.generate_embedding.assert_not_called()
