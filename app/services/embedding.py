"""Confirmed Memory text and bounded OpenAI embedding generation."""
import json
import hashlib
import math
import os
import urllib.request
import urllib.error
from datetime import datetime, timezone

MODEL = "text-embedding-3-small"
DIMENSIONS = 1536


def generate_embedding(value):
    key = os.getenv("OPENAI_API_KEY", "").strip()
    if not key:
        raise ValueError("key_not_configured")
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    request = urllib.request.Request(
        "https://api.openai.com/v1/embeddings",
        data=json.dumps({"model": MODEL, "dimensions": DIMENSIONS,
                         "input": value, "encoding_format": "float"}).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
        method="POST")
    with urllib.request.build_opener(NoRedirect).open(request, timeout=30) as response:
        raw = response.read(256 * 1024 + 1)
        if len(raw) > 256 * 1024:
            raise ValueError("invalid_output")
        result = json.loads(raw)
    vector = result["data"][0]["embedding"]
    if result.get("model") != MODEL or len(vector) != DIMENSIONS or any(
            type(v) not in (float, int) or not math.isfinite(v) for v in vector):
        raise ValueError("invalid_output")
    return json.dumps(vector, allow_nan=False)


def refresh_embedding(memory_id, user_id):
    """Separate transaction: a provider failure cannot undo a saved Memory."""
    from sqlalchemy import select
    from sqlalchemy.orm.attributes import flag_modified
    from ..database import SessionLocal
    from ..models import Memory
    with SessionLocal() as db:
        memory = db.scalar(select(Memory).where(Memory.id == memory_id, Memory.user_id == user_id).with_for_update())
        if memory is None or memory.confirmation_status == "draft":
            return "skipped"
        value = build_embedding_text(memory)
        digest = hashlib.sha256(value.encode()).hexdigest()
        if (memory.embedding_status == "completed" and memory.embedding_text_hash == digest
                and memory.embedding_model == MODEL and memory.embedding_dimensions == DIMENSIONS):
            return "skipped"
        memory.embedding = None
        memory.embedding_model = MODEL
        memory.embedding_dimensions = DIMENSIONS
        memory.embedding_text_hash = digest
        memory.embedding_status = "processing"
        memory.embedding_error = None
        memory.updated_at = memory.updated_at
        flag_modified(memory, "updated_at")
        db.commit()
        try:
            vector = generate_embedding(value)
            error = None
        except urllib.error.HTTPError as exc:
            vector = None
            error = {401: "authentication_failed", 403: "permission_denied", 429: "quota_or_rate_limit", 400: "invalid_input"}.get(exc.code, "provider_error")
        except (TimeoutError, urllib.error.URLError, OSError):
            vector, error = None, "network_or_timeout"
        except Exception:
            vector, error = None, "invalid_output_or_missing_key"
        db.expire_all()
        memory = db.scalar(select(Memory).where(Memory.id == memory_id, Memory.user_id == user_id).with_for_update())
        if memory is None:
            return "skipped"
        if hashlib.sha256(build_embedding_text(memory).encode()).hexdigest() != digest:
            return "skipped"
        memory.embedding = vector
        memory.embedding_status = "failed" if error else "completed"
        memory.embedding_error = error
        memory.embedding_updated_at = datetime.now(timezone.utc)
        memory.updated_at = memory.updated_at
        flag_modified(memory, "updated_at")
        db.commit()
        return memory.embedding_status


def refresh_embedding_safely(memory):
    try:
        return refresh_embedding(memory.id, memory.user_id)
    except Exception:
        # Database failures must not turn a successful Memory save into an error.
        return "failed"


def build_embedding_text(memory) -> str:
    """Build text from confirmed, user-visible semantic fields only."""
    parts = [f"Title: {memory.title}", f"Content: {memory.confirmed_content}"]
    if memory.confirmed_image_text:
        parts.append(f"Confirmed image text: {memory.confirmed_image_text}")
    if memory.category:
        parts.append(f"Category: {memory.category}")
    try:
        tags = json.loads(memory.tags or "[]")
    except (TypeError, ValueError):
        tags = []
    if tags:
        parts.append(f"Tags: {', '.join(str(tag) for tag in tags)}")
    for label, value in (("Event date", memory.event_date), ("Due date", memory.due_date),
                         ("Location", memory.location), ("Amount", memory.amount),
                         ("Currency", memory.currency)):
        if value is not None:
            parts.append(f"{label}: {value}")
    if memory.confirmed_vision:
        try:
            vision = json.loads(memory.confirmed_vision)
        except (TypeError, ValueError):
            vision = {}
        if not isinstance(vision, dict):
            vision = {}
        for key in ("summary", "institution", "location_name", "location_purpose"):
            if vision.get(key):
                parts.append(f"{key.replace('_', ' ').title()}: {vision[key]}")
    return "\n".join(parts)


if __name__ == "__main__":
    from sqlalchemy import select
    from ..main import app  # Initialize the schema before running the backfill.
    from ..config import LOCAL_USER_ID
    from ..database import SessionLocal
    from ..models import Memory

    if not os.getenv("OPENAI_API_KEY", "").strip():
        raise SystemExit("OPENAI_API_KEY is missing")
    with SessionLocal() as db:
        ids = list(db.scalars(select(Memory.id).where(Memory.user_id == LOCAL_USER_ID)))
    counts = {"completed": 0, "failed": 0, "skipped": 0}
    for memory_id in ids:
        try:
            result = refresh_embedding(memory_id, LOCAL_USER_ID)
        except Exception:
            result = "failed"
        counts[result] += 1
        print(f"Memory {memory_id}: {result}", flush=True)
    print(json.dumps(counts))
