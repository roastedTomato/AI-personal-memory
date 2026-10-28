"""Composable read-only retrieval queries. No limits are imposed by these tools."""
import hashlib
import json
from datetime import date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import Float, case, cast, false, literal, or_, select

from ..query_plan import (
    DATE_FIELDS,
    TIME_FIELDS,
    FieldName,
    Filter,
    KeywordMatch,
    SemanticMatch,
    Sort,
)
from . import embedding

if TYPE_CHECKING:
    from sqlalchemy.orm import Session
    from sqlalchemy.sql import Select

    from ..models import Memory

SIMILARITY_THRESHOLD = 0.25  # Same initial, uncalibrated threshold as existing Q&A.
CONFIRMED_STATES = ('confirmed', 'accepted')


def _owned(statement):
    from ..config import LOCAL_USER_ID
    from ..models import Memory

    return statement.where(Memory.user_id == LOCAL_USER_ID,
                           Memory.confirmation_status.in_(CONFIRMED_STATES))


def _column(field: str):
    from typing import get_args

    from ..models import Memory

    # Never pass model-provided identifiers to SQL or unrestricted getattr.
    columns = {name: getattr(Memory, name) for name in get_args(FieldName)}
    return columns[field]


def _literal_pattern(value: str) -> str:
    return '%' + value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'


def event_day(memory) -> date | None:
    """Typed date wins; accept only valid, non-uncertain reviewed legacy dates."""
    if memory.event_date is not None:
        return memory.event_date
    try:
        fields = json.loads(memory.confirmed_vision or '{}')
        if 'date' in fields.get('uncertain_fields', []):
            return None
        value = fields['date']
        parsed = date.fromisoformat(value)
        return parsed if parsed.isoformat() == value else None
    except (ValueError, TypeError, KeyError, AttributeError):
        return None


def structured_search(filters: list[Filter], sorts: list[Sort], db: 'Session | None' = None) -> 'Select':
    """AND structured predicates; sort keys have input priority, NULLs always last.

    Resolve reviewed legacy event dates without changing records or casting invalid JSON.
    SQL NULL never satisfies an ordinary comparison, including ne.
    """
    from ..models import Memory

    statement = _owned(select(Memory))
    event_column = Memory.event_date
    if db is not None and any(op.field == 'event_date' for op in [*filters, *sorts]):
        # Parse JSON in Python to safely reject invalid/uncertain dates. The CASE
        # binds valid dates by ID so SQL filtering AND chronological sorting use
        # the same date before semantic ranking and any result limit.
        rows = db.execute(_owned(select(Memory.id, Memory.event_date, Memory.confirmed_vision)).where(
            Memory.event_date.is_(None), Memory.confirmed_vision.is_not(None))).all()
        legacy = {row.id: day for row in rows if (day := event_day(row)) is not None}
        if legacy:
            event_column = case(legacy, value=Memory.id, else_=Memory.event_date)
    for raw in filters:
        operation = Filter.model_validate(raw.model_dump())
        column = event_column if operation.field == 'event_date' else _column(operation.field)
        if operation.operator == 'is_null':
            predicate = column.is_(None)
        elif operation.operator == 'is_not_null':
            predicate = column.is_not(None)
        else:
            value = operation.value
            if operation.field in DATE_FIELDS:
                value = date.fromisoformat(value)
            elif operation.field in TIME_FIELDS:
                value = datetime.fromisoformat(value)
            elif operation.field == 'amount':
                value = Decimal(value)
            predicates = {
                'eq': column.__eq__, 'ne': column.__ne__, 'gt': column.__gt__,
                'gte': column.__ge__, 'lt': column.__lt__, 'lte': column.__le__,
            }
            predicate = (column.ilike(_literal_pattern(value), escape='\\')
                         if operation.operator == 'contains' else predicates[operation.operator](value))
        statement = statement.where(predicate)
    for raw in sorts:
        operation = Sort.model_validate(raw.model_dump())
        column = event_column if operation.field == 'event_date' else _column(operation.field)
        statement = statement.order_by((column.asc() if operation.direction == 'asc' else column.desc()).nulls_last())
    return statement


def keyword_search(statement: 'Select', operation: KeywordMatch) -> 'Select':
    """Reuse existing ILIKE substring matching, restricted to confirmed visible fields.

    Percent/underscore in user text are literals, not wildcard instructions.
    Original text is excluded because it can differ from reviewed content.
    """
    from ..models import Memory

    operation = KeywordMatch.model_validate(operation.model_dump())
    pattern = _literal_pattern(operation.query.strip())
    columns = (Memory.title, Memory.confirmed_content, Memory.confirmed_image_text,
               Memory.category, Memory.tags)
    return _owned(statement).where(or_(*(column.ilike(pattern, escape='\\') for column in columns)))


def valid_embedding(memory: 'Memory') -> bool:
    return (memory.embedding is not None and memory.embedding_status == 'completed'
            and memory.embedding_model == embedding.MODEL
            and memory.embedding_dimensions == embedding.DIMENSIONS
            and memory.embedding_text_hash == hashlib.sha256(
                embedding.build_embedding_text(memory).encode()).hexdigest())


def semantic_search(db: 'Session', statement: 'Select', operation: SemanticMatch):
    """Intersect eligible rows with pgvector cosine matches; return query and score.

    Preserve the existing model/dimension/hash checks. Filter before ranking; never
    cap candidates. The router owns final ranking and the explicit result limit.
    """
    from ..models import EmbeddingVector, Memory

    operation = SemanticMatch.model_validate(operation.model_dump())
    statement = _owned(statement).where(
        Memory.embedding.is_not(None), Memory.embedding_status == 'completed',
        Memory.embedding_model == embedding.MODEL,
        Memory.embedding_dimensions == embedding.DIMENSIONS)
    candidates = db.scalars(statement.order_by(None).execution_options(populate_existing=True)).all()
    eligible = [memory.id for memory in candidates if valid_embedding(memory)]
    if not eligible:
        return statement.where(false()), literal(0.0)
    # Existing client validates dimensions and finite vector components. Bind the
    # vector as a parameter; the operator and type are fixed application code.
    vector = embedding.generate_embedding(operation.query.strip())
    distance = Memory.embedding.op('<=>', return_type=Float)(cast(literal(vector), EmbeddingVector()))
    score = literal(1.0) - distance
    return statement.where(Memory.id.in_(eligible), score >= SIMILARITY_THRESHOLD), score
