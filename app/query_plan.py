"""Declarative query plans only: no database access or operation execution."""
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Literal, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

FieldName = Literal['title', 'confirmed_content', 'category', 'tags', 'event_date',
                    'due_date', 'location', 'amount', 'currency', 'created_at',
                    'updated_at', 'reminder_at', 'source_type']
SortField = Literal['event_date', 'due_date', 'amount', 'created_at', 'updated_at', 'reminder_at', 'title']
DATE_FIELDS = {'event_date', 'due_date'}
TIME_FIELDS = {'created_at', 'updated_at', 'reminder_at'}
SUPPORTED_OPERATIONS = frozenset({'filter', 'sort', 'semantic_match', 'keyword_match', 'limit'})
PLANNED_OPERATIONS = frozenset({'aggregate', 'calculate_distance', 'convert_currency'})


class PlanModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Filter(PlanModel):
    operation: Literal['filter']
    field: FieldName
    operator: Literal['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'is_null', 'is_not_null']
    value: str | None = Field(max_length=1000)

    @model_validator(mode='after')
    def valid_predicate(self):
        if self.operator in {'is_null', 'is_not_null'}:
            if self.value is not None:
                raise ValueError('Null checks require null value')
            return self
        if self.value is None or not self.value.strip():
            raise ValueError('Filter value is required')
        ordered = self.field in DATE_FIELDS | TIME_FIELDS | {'amount'}
        if self.operator == 'contains' and ordered:
            raise ValueError('Contains requires a text field')
        if self.operator in {'gt', 'gte', 'lt', 'lte'} and not ordered:
            raise ValueError('Comparison requires a date or amount field')
        if self.field in DATE_FIELDS:
            if date.fromisoformat(self.value).isoformat() != self.value:
                raise ValueError('Use ISO date')
        elif self.field in TIME_FIELDS:
            parsed = datetime.fromisoformat(self.value)
            if parsed.tzinfo is None:
                raise ValueError('Timestamp requires timezone')
        elif self.field == 'amount':
            try:
                if not Decimal(self.value).is_finite():
                    raise ValueError('Amount must be finite')
            except InvalidOperation:
                raise ValueError('Invalid amount') from None
        elif self.field == 'currency':
            if len(self.value) != 3 or not self.value.isascii() or not self.value.isalpha() or not self.value.isupper():
                raise ValueError('Use uppercase ISO currency code')
        return self


class Sort(PlanModel):
    operation: Literal['sort']
    field: SortField
    direction: Literal['asc', 'desc']
    nulls: Literal['last']


class SemanticMatch(PlanModel):
    operation: Literal['semantic_match']
    query: str = Field(min_length=1, max_length=1000, pattern=r'\S')


class KeywordMatch(PlanModel):
    operation: Literal['keyword_match']
    query: str = Field(min_length=1, max_length=1000, pattern=r'\S')


class Limit(PlanModel):
    operation: Literal['limit']
    count: int = Field(ge=1, le=100)


class Aggregate(PlanModel):
    operation: Literal['aggregate']
    function: Literal['count', 'sum', 'average', 'min', 'max']
    field: Literal['amount'] | None

    @model_validator(mode='after')
    def valid_target(self):
        if (self.function == 'count') != (self.field is None):
            raise ValueError('Count uses null field; numeric aggregates require amount')
        return self


class CalculateDistance(PlanModel):
    operation: Literal['calculate_distance']
    field: Literal['location']
    origin: str | None = Field(min_length=1, max_length=500, pattern=r'\S')
    unit: Literal['km', 'miles']
    order: Literal['asc', 'desc']


class ConvertCurrency(PlanModel):
    operation: Literal['convert_currency']
    field: Literal['amount']
    source_currency: str | None = Field(pattern=r'^[A-Z]{3}$')
    target_currency: str | None = Field(pattern=r'^[A-Z]{3}$')
    rate_date: str | None

    @model_validator(mode='after')
    def valid_rate_date(self):
        if self.rate_date is not None and date.fromisoformat(self.rate_date).isoformat() != self.rate_date:
            raise ValueError('Use ISO date')
        return self


Operation = Union[Filter, Sort, SemanticMatch, KeywordMatch, Limit, Aggregate,
                  CalculateDistance, ConvertCurrency]


class QueryPlan(PlanModel):
    """Ordered operations; filters combine with AND. Capability is derived, never LLM trusted.

    supported means schema-supported for the future router, not currently executed.
    Missing/ambiguous parameters are represented by clarification questions; incomplete
    executable operations must be omitted rather than populated with invented values.
    """
    version: Literal['1']
    operations: list[Operation] = Field(max_length=20)
    clarification_questions: list[str] = Field(max_length=10)

    @model_validator(mode='after')
    def valid_plan(self):
        if not self.operations and not self.clarification_questions:
            raise ValueError('Plan requires operations or clarification')
        if any(not q.strip() or len(q) > 500 for q in self.clarification_questions):
            raise ValueError('Invalid clarification question')
        if any(isinstance(op, CalculateDistance) and op.origin is None or
               isinstance(op, ConvertCurrency) and (op.target_currency is None or op.rate_date is None)
               for op in self.operations) and not self.clarification_questions:
            raise ValueError('Missing parameters require clarification')
        return self

    @property
    def required_future_tools(self) -> list[str]:
        return sorted({op.operation for op in self.operations} & PLANNED_OPERATIONS)

    @property
    def status(self) -> Literal['needs_clarification', 'requires_future_tools', 'supported']:
        if self.clarification_questions:
            return 'needs_clarification'
        return 'requires_future_tools' if self.required_future_tools else 'supported'
