"""Stable category taxonomy shared by manual and AI-created Memories."""
import json
import unicodedata

from sqlalchemy import text

CANONICAL_CATEGORIES = ("bill", "receipt", "notice", "event", "appointment", "travel", "other")

ALIASES = {
    "bill": "bill", "billing": "bill", "invoice": "bill", "expense": "bill", "payment": "bill",
    "账单": "bill", "发票": "bill", "费用": "bill", "付款": "bill",
    "receipt": "receipt", "purchase receipt": "receipt", "收据": "receipt", "小票": "receipt",
    "notice": "notice", "notification": "notice", "announcement": "notice", "通知": "notice", "公告": "notice",
    "event": "event", "event announcement": "event", "event notice": "event", "activity": "event",
    "活动": "event", "活动通知": "event", "活动公告": "event",
    "appointment": "appointment", "booking": "appointment", "reservation": "appointment",
    "预约": "appointment", "预订": "appointment",
    "travel": "travel", "trip": "travel", "itinerary": "travel", "旅行": "travel", "行程": "travel",
    "other": "other", "misc": "other", "miscellaneous": "other", "其他": "other", "未分类": "other",
}


def normalize_category(raw: str | None) -> str | None:
    if raw is None:
        return None
    value = " ".join(unicodedata.normalize("NFKC", raw).casefold().replace("_", " ").replace("-", " ").split())
    if not value:
        return None
    return ALIASES.get(value, "other")


def normalize_existing_memory_categories(connection) -> int:
    """Normalize category fields without changing document content, tags, or reminders."""
    changed = 0
    rows = connection.execute(text(
        "SELECT id, category, confirmed_vision, vision_draft FROM memories"
    )).mappings()
    for row in rows:
        category = normalize_category(row["category"])
        confirmed_vision = row["confirmed_vision"]
        vision_draft = row["vision_draft"]

        def normalize_json(raw, nested=False):
            if not raw:
                return raw
            try:
                value = json.loads(raw)
            except (TypeError, ValueError):
                return raw
            target = value.get("draft") if nested and isinstance(value, dict) else value
            if not isinstance(target, dict) or "category" not in target:
                return raw
            normalized = normalize_category(target.get("category"))
            if normalized == target.get("category"):
                return raw
            target["category"] = normalized
            return json.dumps(value, ensure_ascii=False)

        new_confirmed = normalize_json(confirmed_vision)
        new_draft = normalize_json(vision_draft, nested=True)
        if (category, new_confirmed, new_draft) != (row["category"], confirmed_vision, vision_draft):
            connection.execute(text(
                "UPDATE memories SET category = :category, confirmed_vision = :confirmed_vision, "
                "vision_draft = :vision_draft WHERE id = :id"
            ), {"category": category, "confirmed_vision": new_confirmed, "vision_draft": new_draft, "id": row["id"]})
            changed += 1
    return changed
