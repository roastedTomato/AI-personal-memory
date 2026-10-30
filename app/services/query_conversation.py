"""Durable, owner-scoped, single-use clarification; expiry is cleaned lazily."""
import json
import re
from collections import OrderedDict
from threading import RLock
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert as pg_insert
from ..query_plan import CalculateDistance, QueryPlan
from ..models import PendingClarification
from ..database import SessionLocal
from ..config import APP_ENV
from . import intent_classifier

TTL_SECONDS = 900
MAX_LOCAL_PENDING = 128
_local_pending = OrderedDict()
_local_lock = RLock()

@dataclass
class PendingQuery:
    request: dict
    plan: QueryPlan
    expires_at: datetime


def save_pending(owner, conversation_id, request, plan, db=None):
    if APP_ENV == 'local':
        now = datetime.now(UTC)
        with _local_lock:
            for key in list(_local_pending):
                if _local_pending[key].expires_at <= now:
                    del _local_pending[key]
            key = (owner, conversation_id)
            _local_pending[key] = PendingQuery(dict(request), plan.model_copy(deep=True),
                                               now + timedelta(seconds=TTL_SECONDS))
            _local_pending.move_to_end(key)
            while len(_local_pending) > MAX_LOCAL_PENDING:
                _local_pending.popitem(last=False)
        return
    if db is None:
        with SessionLocal() as session:
            return save_pending(owner, conversation_id, request, plan, session)
    values = dict(user_id=owner, conversation_id=conversation_id,
                  request_json=json.dumps(request), plan_json=plan.model_dump_json(),
                  expires_at=datetime.now(UTC) + timedelta(seconds=TTL_SECONDS))
    db.execute(delete(PendingClarification).where(PendingClarification.user_id == owner,
               PendingClarification.expires_at <= datetime.now(UTC)))
    if db.bind.dialect.name == 'postgresql':
        statement = pg_insert(PendingClarification).values(**values)
        db.execute(statement.on_conflict_do_update(index_elements=['user_id', 'conversation_id'],
                   set_={k: v for k, v in values.items() if k not in {'user_id', 'conversation_id'}}))
    else:
        db.merge(PendingClarification(**values))
    db.commit()


def take_pending(owner, conversation_id, db=None):
    if APP_ENV == 'local':
        with _local_lock:
            pending = _local_pending.pop((owner, conversation_id), None)
        return pending if pending and pending.expires_at > datetime.now(UTC) else None
    if db is None:
        with SessionLocal() as session:
            return take_pending(owner, conversation_id, session)
    row = db.execute(delete(PendingClarification).where(
        PendingClarification.user_id == owner, PendingClarification.conversation_id == conversation_id
    ).returning(PendingClarification.request_json, PendingClarification.plan_json,
                PendingClarification.expires_at)).first()
    db.commit()
    if row is None or row.expires_at.replace(tzinfo=UTC) <= datetime.now(UTC):
        return None
    return PendingQuery(json.loads(row.request_json), QueryPlan.model_validate_json(row.plan_json), row.expires_at)


def new_question(text: str) -> tuple[bool, str]:
    """Explicit reset prefix plus obvious independent questions; short replies resume."""
    prefix = re.match(r'^\s*(?:new question|新问题)\s*[:：]\s*(.+)$', text, re.IGNORECASE | re.DOTALL)
    if prefix:
        return True, prefix.group(1).strip()
    independent = bool(re.match(r'^(?:what|which|where|when|how|who|find|show|list|search|can you|do i)\b|^(?:什么|哪个|哪里|查找|帮我找)', text.strip(), re.IGNORECASE))
    return independent, text.strip()


def resume_plan(pending: PendingQuery, reply: str) -> QueryPlan:
    missing_origins = [op for op in pending.plan.operations
                       if isinstance(op, CalculateDistance) and op.origin is None]
    if missing_origins and len(pending.plan.clarification_questions) == 1 and len(reply) <= 500:
        # A single missing origin can be supplied literally. No geocoding, location
        # inference or LLM call: the router will still block the future capability.
        operations = [op.model_copy(update={'origin': reply}) if op in missing_origins else op
                      for op in pending.plan.operations]
        return QueryPlan.model_validate({**pending.plan.model_dump(),
                                        'operations': [op.model_dump() for op in operations],
                                        'clarification_questions': []})
    return intent_classifier.classify_question(
        pending.request['question'], date.fromisoformat(pending.request['today']),
        clarification_context={'pending_plan': pending.plan.model_dump(), 'reply': reply})
