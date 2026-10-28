"""Isolated SQLite execution plus PostgreSQL SQL compilation; no provider calls.

SQLite test compilers translate only pgvector's distance operator/cast to a local
cosine function, so the production query composition and ranking run unchanged.
"""
import hashlib
import json
import math
import os
from datetime import date, datetime, timezone
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

from app.query_plan import Filter, KeywordMatch, QueryPlan, SemanticMatch
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
            fields = dict(user_id='local-dev-user', title=title, original_text='unreviewed private original',
                          confirmed_content='Reviewed content', category='event', tags='[]',
                          confirmation_status='confirmed', source_type='manual',
                          created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
                          updated_at=datetime(2026, 1, 1, tzinfo=timezone.utc))
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
    future = store.add('Reminder', reminder_at=datetime(2026, 12, 1, 10, tzinfo=timezone.utc))
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
    first = store.add('A', amount=Decimal('10'))
    second = store.add('A', amount=Decimal('10'))
    store.add('Z', amount=Decimal('10'))
    store.add('B', amount=Decimal('5'))
    result = execute(store, limit(3), sort('amount', 'desc'), sort('title'), limit(2))
    assert ids(result) == [first.id, second.id]


def test_multiple_keywords_are_intersected(store):
    match = store.add('Spark insurance')
    store.add('Spark alone')
    assert ids(execute(store, keyword('Spark'), keyword('insurance'))) == [match.id]


def test_empty_results_and_missing_date_not_inferred(store):
    store.add('Legacy date', confirmed_vision=json.dumps({'date': '2026-12-01'}))
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
    store.add('Expensive', indexed=True, amount=Decimal('100'))
    cheap = store.add('Cheap', indexed=True, amount=Decimal('10'))
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
    statement, score = retrieval_tools.semantic_search(store.db, retrieval_tools.structured_search([], []), SemanticMatch(**semantic('content')))
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
