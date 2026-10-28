"""Execute validated plans without answering, aggregating, or changing records."""
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ..query_plan import Filter, KeywordMatch, Limit, QueryPlan, SemanticMatch, Sort
from . import embedding, retrieval_tools, vision


class MemoryMatch(BaseModel):
    memory_id: int
    title: str
    citation: str
    memory_url: str
    source_type: str
    source_image_url: str | None
    confirmed_content: str
    event_date: date | None
    due_date: date | None
    amount: Decimal | None
    currency: str | None
    location: str | None
    reminder_at: datetime | None
    relevance: float | None


class ExecutionError(BaseModel):
    code: Literal['invalid_plan', 'database_error', 'semantic_unavailable', 'retrieval_failed']
    message: str


class QueryResult(BaseModel):
    status: Literal['completed', 'no_matches', 'needs_clarification', 'requires_future_tools',
                    'invalid_plan', 'execution_failed']
    memories: list[MemoryMatch] = Field(default_factory=list)
    retrieval_method: list[Literal['structured_search', 'keyword_search', 'semantic_search']] = Field(default_factory=list)
    applied_operations: list[dict[str, Any]] = Field(default_factory=list)
    clarification_questions: list[str] = Field(default_factory=list)
    unsupported_capabilities: list[str] = Field(default_factory=list)
    error: ExecutionError | None = None


ERROR_MESSAGES = {
    'invalid_plan': 'The query plan is invalid.',
    'database_error': 'The database could not complete retrieval.',
    'semantic_unavailable': 'Semantic retrieval is unavailable.',
    'retrieval_failed': 'Retrieval could not be completed.',
}


def _failure(code, methods=()):
    return QueryResult(status='invalid_plan' if code == 'invalid_plan' else 'execution_failed',
                       retrieval_method=list(methods),
                       error=ExecutionError(code=code, message=ERROR_MESSAGES[code]))


def execute_query_plan(plan: QueryPlan | dict, db: Session) -> QueryResult:
    """Execute relational stages: filters -> keyword -> semantic -> sort -> limit.

    Predicates always combine with AND, regardless of their serialized position.
    Multiple sort keys retain priority in input order. Explicit sorts override
    semantic rank; otherwise mean cosine score ranks multiple semantic matches.
    Multiple limits use the smallest count. ID is the deterministic final tie-break.
    applied_operations records successful execution order; failures return no partial
    records or applied operations. The caller owns session/transaction lifecycle.
    """
    try:
        # Revalidate even model instances (which may have been mutated/constructed).
        validated = QueryPlan.model_validate(plan.model_dump() if isinstance(plan, QueryPlan) else plan)
    except (ValidationError, ValueError, TypeError):
        return _failure('invalid_plan')
    if validated.status != 'supported':
        return QueryResult(status=validated.status, clarification_questions=validated.clarification_questions,
                           unsupported_capabilities=validated.required_future_tools)

    filters = [op for op in validated.operations if isinstance(op, Filter)]
    keywords = [op for op in validated.operations if isinstance(op, KeywordMatch)]
    semantics = [op for op in validated.operations if isinstance(op, SemanticMatch)]
    sorts = [op for op in validated.operations if isinstance(op, Sort)]
    limits = [op for op in validated.operations if isinstance(op, Limit)]
    methods = ['structured_search']
    if keywords:
        methods.append('keyword_search')
    if semantics:
        methods.append('semantic_search')
    stage = 'structured'
    try:
        # SELECT must not autoflush unrelated pending writes in the caller's session.
        with db.no_autoflush:
            statement = retrieval_tools.structured_search(filters, sorts, db=db)
            for operation in keywords:
                statement = retrieval_tools.keyword_search(statement, operation)
            scores = []
            stage = 'semantic'
            for operation in semantics:
                statement, score = retrieval_tools.semantic_search(db, statement, operation)
                scores.append(score)
            stage = 'results'
            from ..models import Memory

            relevance = sum(scores) / len(scores) if scores else None
            if relevance is not None:
                statement = statement.order_by(relevance.desc())
                statement = statement.add_columns(relevance.label('relevance'))
            statement = statement.order_by(Memory.id.asc())
            if limits:
                statement = statement.limit(min(op.count for op in limits))
            rows = db.execute(statement.execution_options(populate_existing=True)).all()
            memories = []
            for row in rows:
                memory = row[0]
                # The final fetch may have observed a concurrent content update.
                if semantics and not retrieval_tools.valid_embedding(memory):
                    continue
                memories.append(MemoryMatch(
                    memory_id=memory.id, title=memory.title, citation=f'[Memory {memory.id}]',
                    memory_url=f'/memories/{memory.id}', source_type=memory.source_type,
                    source_image_url=f'/memories/{memory.id}/image/file' if memory.source_image_path else None,
                    confirmed_content=embedding.build_embedding_text(memory),
                    event_date=retrieval_tools.event_day(memory), due_date=memory.due_date,
                    amount=memory.amount, currency=memory.currency,
                    location=(retrieval_tools.location_text(memory)
                              if any(op.field == 'location' for op in filters) else memory.location),
                    reminder_at=memory.reminder_at, relevance=float(row[1]) if semantics else None))
            return QueryResult(status='completed' if memories else 'no_matches', memories=memories,
                               retrieval_method=methods,
                               applied_operations=[op.model_dump() for op in filters + keywords + semantics + sorts + limits])
    except SQLAlchemyError:
        return _failure('database_error', methods)
    except (OSError, ValueError, TypeError, KeyError, IndexError, AttributeError, RuntimeError, vision.VisionError):
        # Do not echo provider output, SQL parameters, document content, or secrets.
        return _failure('semantic_unavailable' if stage == 'semantic' else 'retrieval_failed', methods)
