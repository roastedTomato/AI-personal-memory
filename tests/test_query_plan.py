"""Pure schema/client tests: no database or real provider calls."""
import json
from datetime import date

import pytest
from pydantic import ValidationError

from app.query_plan import QueryPlan
from app.services import intent_classifier as classifier
from app.services import vision


def plan(*operations, questions=None):
    return {'version': '1', 'operations': list(operations), 'clarification_questions': questions or []}


def filt(field, operator, value):
    return {'operation': 'filter', 'field': field, 'operator': operator, 'value': value}


def sort(field):
    return {'operation': 'sort', 'field': field, 'direction': 'asc', 'nulls': 'last'}


EXAMPLES = [
    plan(filt('category', 'eq', 'event'), filt('event_date', 'gte', '2026-10-29'), sort('event_date'), {'operation': 'limit', 'count': 1}),
    plan(filt('category', 'eq', 'bill'), {'operation': 'keyword_match', 'query': 'Spark'}),
    plan(filt('category', 'eq', 'bill'), filt('amount', 'is_not_null', None), sort('amount')),
    plan(filt('category', 'eq', 'event'), filt('event_date', 'gte', '2026-10-29'),
         {'operation': 'calculate_distance', 'field': 'location', 'origin': None, 'unit': 'km', 'order': 'asc'}, questions=['What is your starting location?']),
    plan({'operation': 'semantic_match', 'query': 'insurance'}, {'operation': 'aggregate', 'function': 'sum', 'field': 'amount'},
         questions=['Which date field represents spending, and which currency should be summed?']),
]


@pytest.mark.parametrize('value', EXAMPLES + [
    plan({'operation': 'semantic_match', 'query': 'insurance'}),
    plan(filt('amount', 'lt', '100.50')),
    plan(filt('event_date', 'gte', '2025-01-01'), filt('event_date', 'lte', '2025-12-31'), sort('event_date')),
])
def test_supported_plans_round_trip(value):
    result = QueryPlan.model_validate_json(json.dumps(value))
    assert result.model_dump() == value


@pytest.mark.parametrize('op', [
    {'operation': 'aggregate', 'function': 'count', 'field': None},
    {'operation': 'calculate_distance', 'field': 'location', 'origin': 'Hamilton', 'unit': 'km', 'order': 'asc'},
    {'operation': 'convert_currency', 'field': 'amount', 'source_currency': None, 'target_currency': 'NZD', 'rate_date': '2026-10-29'},
])
def test_future_tools_are_valid_but_not_supported(op):
    result = QueryPlan.model_validate(plan(op))
    assert result.status == 'requires_future_tools'
    assert result.required_future_tools == [op['operation']]


@pytest.mark.parametrize('value', [
    plan(), plan({'operation': 'execute_sql', 'sql': 'SELECT 1'}),
    plan(filt('user_id', 'eq', 'other')), plan(filt('amount', 'contains', '1')),
    plan(filt('amount', 'gt', 'NaN')), plan(filt('amount', 'lt', 'abc')),
    plan(filt('event_date', 'gte', '2026-02-30')), plan(filt('event_date', 'eq', 'yesterday')),
    plan(filt('location', 'gte', 'Hamilton')), plan(filt('amount', 'eq', None)),
    plan(filt('currency', 'eq', '$')), plan(filt('amount', 'is_null', '0')),
    plan({'operation': 'limit', 'count': True}), plan({'operation': 'limit', 'count': 101}),
    plan({'operation': 'semantic_match', 'query': '   '}),
    plan({'operation': 'aggregate', 'function': 'sum', 'field': None}),
    plan({'operation': 'calculate_distance', 'field': 'location', 'origin': None, 'unit': 'km', 'order': 'asc'}),
    plan({'operation': 'convert_currency', 'field': 'amount', 'source_currency': None, 'target_currency': None, 'rate_date': None}),
    {**plan({'operation': 'limit', 'count': 1}), 'sql': 'SELECT 1'},
])
def test_invalid_plans_rejected(value):
    with pytest.raises(ValidationError):
        QueryPlan.model_validate(value)


def test_missing_or_ambiguous_parameters():
    result = QueryPlan.model_validate(plan(questions=['Which date do you mean?']))
    assert result.status == 'needs_clarification'
    assert QueryPlan.model_validate(EXAMPLES[3]).required_future_tools == ['calculate_distance']
    assert QueryPlan.model_validate(EXAMPLES[4]).status == 'needs_clarification'


@pytest.mark.parametrize('value', EXAMPLES)
def test_classifier_uses_existing_client_and_validates(monkeypatch, value):
    def mock_request(payload, output_model):
        assert output_model is QueryPlan
        assert payload['store'] is False
        assert json.loads(payload['input'][0]['content'][0]['text'])['today'] == '2026-10-29'
        assert payload['model'] == 'test-model'
        # Exercise existing provider parsing and schema validation as well.
        return vision.parse_response({'status': 'completed', 'model': 'test-model', 'output': [
            {'content': [{'type': 'output_text', 'text': json.dumps(value)}]}]}, output_model)
    monkeypatch.setenv('OPENAI_RAG_MODEL', 'test-model')
    monkeypatch.setattr(vision, '_request', mock_request)
    assert classifier.classify_question('Find category event', date(2026, 10, 29)).model_dump() == value


@pytest.mark.parametrize('output', ['not json', json.dumps(plan(filt('secret', 'eq', 'x'))), '{}'])
def test_malformed_model_output_is_safe(monkeypatch, output):
    def mock_request(payload, output_model):
        return vision.parse_response({'status': 'completed', 'model': 'mock', 'output': [
            {'content': [{'type': 'output_text', 'text': output}]}]}, output_model)
    monkeypatch.setattr(vision, '_request', mock_request)
    with pytest.raises(classifier.IntentClassifierError, match='^invalid_plan$'):
        classifier.classify_question('question', date(2026, 10, 29))


def test_revalidates_client_result(monkeypatch):
    monkeypatch.setattr(vision, '_request', lambda *args: {'draft': plan(filt('user_id', 'eq', 'secret'))})
    with pytest.raises(classifier.IntentClassifierError, match='^invalid_plan$'):
        classifier.classify_question('question', date(2026, 10, 29))


@pytest.mark.parametrize('code', ['timeout', 'key_not_configured', 'refused'])
def test_provider_errors_preserved(monkeypatch, code):
    def fail(*args):
        raise vision.VisionError(code)
    monkeypatch.setattr(vision, '_request', fail)
    with pytest.raises(classifier.IntentClassifierError, match=f'^{code}$'):
        classifier.classify_question('question', date(2026, 10, 29))


def test_invalid_input_never_calls_provider(monkeypatch):
    monkeypatch.setattr(vision, '_request', lambda *args: pytest.fail('Unexpected request'))
    for question, today in [('', date.today()), ('x' * 1001, date.today()), ('question', '2026-10-29')]:
        with pytest.raises(classifier.IntentClassifierError, match='invalid_input'):
            classifier.classify_question(question, today)


def test_schema_has_required_properties_for_strict_output():
    schema = QueryPlan.model_json_schema()
    for node in [schema, *schema['$defs'].values()]:
        if node.get('type') == 'object':
            assert node['additionalProperties'] is False
            assert set(node['required']) == set(node['properties'])


@pytest.mark.parametrize('question', [
    'How much did I spend on insurance last year?',
    'How much have I spent on groceries this month?',
])
def test_spending_total_is_valid_future_capability_without_provider(monkeypatch, question):
    monkeypatch.setattr(vision, '_request', lambda *args: pytest.fail('Unexpected provider request'))
    result = classifier.classify_question(question, date(2026, 10, 29))
    assert result.status == 'requires_future_tools'
    assert result.required_future_tools == ['aggregate']
    assert result.operations[0].query == question
    assert result.operations[1].function == 'sum'
    assert result.operations[1].field == 'amount'
    assert result.clarification_questions == []
    assert QueryPlan.model_validate_json(result.model_dump_json()).status == 'requires_future_tools'
