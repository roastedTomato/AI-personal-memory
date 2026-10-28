"""One expiring pending clarification per owner/conversation; no chat transcript."""
import re
from collections import OrderedDict
from dataclasses import dataclass
from datetime import date
from threading import RLock
from time import monotonic

from ..query_plan import CalculateDistance, QueryPlan
from . import intent_classifier

TTL_SECONDS = 900
MAX_PENDING = 128


@dataclass
class PendingQuery:
    request: dict
    plan: QueryPlan
    expires_at: float


_pending: OrderedDict[tuple[str, str], PendingQuery] = OrderedDict()
_lock = RLock()


def save_pending(owner: str, conversation_id: str, request: dict, plan: QueryPlan) -> None:
    with _lock:
        now = monotonic()
        for key in list(_pending):
            if _pending[key].expires_at <= now:
                del _pending[key]
        key = (owner, conversation_id)
        _pending[key] = PendingQuery(dict(request), plan.model_copy(deep=True), now + TTL_SECONDS)
        _pending.move_to_end(key)
        while len(_pending) > MAX_PENDING:
            _pending.popitem(last=False)


def take_pending(owner: str, conversation_id: str) -> PendingQuery | None:
    with _lock:
        pending = _pending.pop((owner, conversation_id), None)
    return pending if pending and pending.expires_at > monotonic() else None


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
