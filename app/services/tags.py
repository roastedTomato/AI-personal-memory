"""Conservative, deterministic tag cleanup; no document text or AI calls are logged."""
import json
import re
import unicodedata

from sqlalchemy import text

MONTHS = set("january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec".split())
WEEKDAYS = set("monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun".split())
FREQUENCIES = set("daily weekly monthly yearly annually biweekly fortnightly everyday everyweek 每天 每周 每月 每年 周期性 每星期".split())
GENERIC = set("misc miscellaneous general generic other unknown important note notes document documents image photo picture text file files mock-ai 未分类 其他 杂项 重要 笔记 文档 图片 照片 文本 文件".split())
ALIASES = {"wonders": "wonder", "wonder opportunity": "wonder", "wonder opportunities": "wonder", "hand made": "handmade", "market day": "market", "market days": "market"}


def canonical_tag(raw: str, content: str = "") -> str | None:
    value = " ".join(unicodedata.normalize("NFKC", raw).casefold().split()).strip(" ,.;:!?，。；：！？#")
    if not value or len(value) > 60 or re.fullmatch(r"\d{1,4}([-/.]\d{1,2}){0,2}", value):
        return None
    if value in MONTHS | WEEKDAYS | FREQUENCIES | GENERIC:
        return None
    context = unicodedata.normalize("NFKC", content).casefold()
    if value in {"opportunity", "opportunities"} and re.search(r"\bwonders?\s+opportunit", context):
        value = "wonder"
    value = ALIASES.get(value, value)
    # Normalize simple English plurals, while leaving words such as 'news' intact.
    if re.fullmatch(r"[a-z]+", value) and len(value) > 4:
        if value.endswith("ies") and len(value) > 5: value = value[:-3] + "y"
        elif value.endswith("s") and not value.endswith(("ss", "us", "is", "ws")): value = value[:-1]
    if value in GENERIC:
        return None
    return value


def normalize_tags(tags: list[str], content: str = "", limit: int | None = None) -> list[str]:
    result = []
    seen = set()
    for raw in tags:
        if not isinstance(raw, str):
            continue
        tag = canonical_tag(raw, content)
        if tag and tag not in seen:
            seen.add(tag)
            result.append(tag)
            if limit is not None and len(result) >= limit: break
    return result


def normalize_existing_memory_tags(connection) -> int:
    """Idempotent startup cleanup. Only tags and confirmed_vision are updated."""
    changed = 0
    rows = connection.execute(text("SELECT id, tags, original_text, confirmed_content, confirmed_vision FROM memories")).mappings()
    for row in rows:
        try:
            old_tags = json.loads(row["tags"] or "[]")
            if not isinstance(old_tags, list): continue
        except (ValueError, TypeError):
            continue
        context = (row["original_text"] or "") + " " + (row["confirmed_content"] or "")
        new_tags = normalize_tags(old_tags, context)
        updates = {}
        if new_tags != old_tags: updates["tags"] = json.dumps(new_tags, ensure_ascii=False)
        if row["confirmed_vision"]:
            try:
                confirmed = json.loads(row["confirmed_vision"])
                if isinstance(confirmed, dict) and isinstance(confirmed.get("tags"), list):
                    normalized = normalize_tags(confirmed["tags"], context, limit=4)
                    if normalized != confirmed["tags"]:
                        confirmed["tags"] = normalized
                        updates["confirmed_vision"] = json.dumps(confirmed, ensure_ascii=False)
            except (ValueError, TypeError):
                pass
        if updates:
            if "confirmed_vision" in updates:
                connection.execute(text("UPDATE memories SET tags = :tags, confirmed_vision = :confirmed_vision WHERE id = :id"), {"tags": updates.get("tags", row["tags"]), "confirmed_vision": updates["confirmed_vision"], "id": row["id"]})
            else:
                connection.execute(text("UPDATE memories SET tags = :tags WHERE id = :id"), {"tags": updates["tags"], "id": row["id"]})
            changed += 1
    return changed
