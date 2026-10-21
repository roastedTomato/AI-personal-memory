import hashlib
import json
import os
import time
from datetime import datetime, timezone
from threading import Lock
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from ..database import get_db
from ..services import vision
from ..services.categories import normalize_category
from ..services.tags import normalize_tags
from .images import managed_image, owned
from .memories import to_read

router = APIRouter(prefix="/memories", tags=["vision"])
_gate = Lock()


class VisionRequest(BaseModel):
    consent: Literal[True]
    request_id: str = Field(min_length=1, max_length=100)


class TextAnalysisRequest(VisionRequest):
    text_confirmed: Literal[True]
    text: str = Field(min_length=1, max_length=12000)


class DraftAnalysisRequest(VisionRequest):
    text: str = Field(min_length=1, max_length=12000)


class ImageFinalizeRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    text: str = Field(default="", max_length=12000)
    source_image_path: str
    draft_id: str | None = None
    draft: vision.VisionDraft | None = None


class ManualImageTextRequest(BaseModel):
    text_confirmed: Literal[True]
    text: str = Field(min_length=1, max_length=12000)
    source_image_path: str


class VisionAccept(BaseModel):
    draft_id: str
    draft: vision.VisionDraft
    title: str | None = Field(default=None, min_length=1, max_length=200)


class ConfirmedImageUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    confirmed_content: str = Field(max_length=12000)
    draft: vision.VisionDraft | None = None


def envelope(memory):
    return {"memory_id": memory.id,
            "vision": json.loads(memory.vision_draft) if memory.vision_draft else None,
            "recognition": json.loads(memory.image_text_draft) if memory.image_text_draft else None,
            "metadata": json.loads(memory.vision_metadata) if memory.vision_metadata else None}


def run_stage(memory_id, payload, stage, db):
    memory = owned(db, memory_id)
    if not _gate.acquire(blocking=False): raise HTTPException(409, detail="vision_busy")
    try:
        if not db.scalar(text("SELECT pg_try_advisory_xact_lock(38380001)")):
            raise HTTPException(409, detail="vision_busy")
        db.refresh(memory, with_for_update=True)
        path = managed_image(memory)
        # Hashes support deduplication without putting document text in metadata/logs.
        signature = hashlib.sha256((stage + memory.source_image_path + (payload.text if stage == "analysis" else "")).encode()).hexdigest()
        metadata = json.loads(memory.vision_metadata) if memory.vision_metadata else {}
        if metadata.get("request_id") == payload.request_id:
            if metadata.get("signature") != signature: raise HTTPException(409, detail="request_id_conflict")
            return envelope(memory)
        if metadata.get("stage") == stage and time.time() - metadata.get("attempt_at", 0) < 15:
            raise HTTPException(429, detail="vision_cooldown")
        metadata = {"request_id": payload.request_id, "stage": stage, "signature": signature,
                    "attempt_at": time.time(), "model": os.environ.get("OPENAI_VISION_MODEL", vision.DEFAULT_MODEL)}
        started = time.perf_counter()
        try:
            result = vision.recognize_image(path) if stage == "recognition" else vision.analyze_image(path) if stage == "image_full" else vision.analyze_text(payload.text)
        except vision.VisionError as exc:
            metadata.update(status="failed", error=exc.code, duration_ms=round((time.perf_counter()-started)*1000), usage=exc.usage, diagnostics=exc.diagnostics)
            memory.vision_metadata = json.dumps(metadata)
            db.commit()
            return envelope(memory)
        metadata.update(status="generated", model=result["model"], usage=result["usage"], duration_ms=result["duration_ms"])
        memory.updated_at = datetime.now(timezone.utc)
        if stage == "recognition":
            value = result["draft"]
            metadata["status"] = "generated" if value["text"] and value["text"].strip() else "no_text"
            memory.image_text_draft = json.dumps({"text": value["text"], "warnings": value["warnings"], "source_image_path": memory.source_image_path})
            memory.vision_draft = None
        else:
            if stage == "image_full":
                recognized_text = result["draft"].get("recognized_text")
                fields = {key: value for key, value in result["draft"].items() if key != "recognized_text"}
                memory.image_text_draft = json.dumps({"text": recognized_text, "warnings": fields["warnings"], "source_image_path": memory.source_image_path})
            else:
                recognized_text = payload.text
                fields = result["draft"]
            fields["tags"] = normalize_tags(fields["tags"], recognized_text or memory.original_text, limit=4)
            fields["category"] = normalize_category(fields.get("category"))
            memory.vision_draft = json.dumps({"draft_id": uuid4().hex, "stage": "analysis", "origin_stage": stage, "draft": fields,
                                             "reviewed_text": recognized_text or "", "source_image_path": memory.source_image_path,
                                             "version": memory.updated_at.isoformat()})
        memory.vision_metadata = json.dumps(metadata)
        db.commit()
        return envelope(memory)
    finally:
        _gate.release()


@router.post("/{memory_id}/image/recognize")
def recognize(memory_id: int, payload: VisionRequest, db: Session = Depends(get_db)):
    return run_stage(memory_id, payload, "recognition", db)


@router.post("/{memory_id}/image/analyze")
def analyze(memory_id: int, payload: TextAnalysisRequest, db: Session = Depends(get_db)):
    if not payload.text.strip(): raise HTTPException(422, detail="invalid_text")
    return run_stage(memory_id, payload, "analysis", db)


@router.post("/{memory_id}/image/reanalyze")
def reanalyze_image(memory_id: int, payload: VisionRequest, db: Session = Depends(get_db)):
    return run_stage(memory_id, payload, "image_full", db)


@router.post("/{memory_id}/image/analyze-draft")
def analyze_draft(memory_id: int, payload: DraftAnalysisRequest, db: Session = Depends(get_db)):
    if not payload.text.strip(): raise HTTPException(422, detail="invalid_text")
    return run_stage(memory_id, payload, "analysis", db)


@router.post("/{memory_id}/image/finalize")
def finalize_image(memory_id: int, payload: ImageFinalizeRequest, db: Session = Depends(get_db)):
    memory = owned(db, memory_id)
    db.refresh(memory, with_for_update=True)
    if payload.source_image_path != memory.source_image_path:
        raise HTTPException(409, detail="stale_vision_draft")
    managed_image(memory)
    if not payload.title.strip(): raise HTTPException(422, detail="invalid_title")
    if (payload.draft_id is None) != (payload.draft is None):
        raise HTTPException(422, detail="draft_pair_required")
    if payload.draft is not None:
        pending = json.loads(memory.vision_draft) if memory.vision_draft else {}
        if (pending.get("stage") != "analysis" or pending.get("draft_id") != payload.draft_id
                or pending.get("source_image_path") != memory.source_image_path
                or pending.get("version") != memory.updated_at.isoformat()):
            raise HTTPException(409, detail="stale_vision_draft")
        cleaned = payload.draft.model_copy(update={"tags": normalize_tags(payload.draft.tags, payload.draft.summary or payload.text, limit=4), "category": normalize_category(payload.draft.category)})
        memory.confirmed_vision = cleaned.model_dump_json()
        memory.category = cleaned.category
        memory.tags = json.dumps(cleaned.tags)
    memory.title = payload.title.strip()
    memory.confirmed_image_text = payload.text or None
    memory.confirmed_content = payload.draft.summary if payload.draft and payload.draft.summary else payload.text
    memory.confirmation_status = "accepted" if payload.draft else "confirmed"
    memory.vision_draft = None
    db.commit(); db.refresh(memory)
    return to_read(memory)


@router.patch("/{memory_id}/image/confirmed")
def update_confirmed_image(memory_id: int, payload: ConfirmedImageUpdate, db: Session = Depends(get_db)):
    memory = owned(db, memory_id)
    db.refresh(memory, with_for_update=True)
    if not memory.source_image_path or memory.confirmation_status == "draft":
        raise HTTPException(409, detail="image_not_confirmed")
    if not payload.title.strip(): raise HTTPException(422, detail="invalid_title")
    memory.title = payload.title.strip()
    memory.confirmed_content = payload.confirmed_content
    if payload.draft is not None:
        cleaned = payload.draft.model_copy(update={"tags": normalize_tags(payload.draft.tags, payload.confirmed_content, limit=4), "category": normalize_category(payload.draft.category)})
        memory.confirmed_vision = cleaned.model_dump_json()
        memory.category = cleaned.category
        memory.tags = json.dumps(cleaned.tags)
    db.commit(); db.refresh(memory)
    return to_read(memory)


@router.post("/{memory_id}/image/text/save")
def save_text(memory_id: int, payload: ManualImageTextRequest, db: Session = Depends(get_db)):
    memory = owned(db, memory_id)
    db.refresh(memory, with_for_update=True)
    if not payload.text.strip(): raise HTTPException(422, detail="invalid_text")
    if payload.source_image_path != memory.source_image_path:
        raise HTTPException(409, detail="stale_vision_draft")
    managed_image(memory)
    memory.confirmed_image_text = payload.text
    memory.confirmed_content = payload.text
    memory.confirmation_status = "confirmed"
    memory.vision_draft = None
    db.commit(); db.refresh(memory)
    return to_read(memory)


@router.post("/{memory_id}/image/vision", deprecated=True)
def legacy(memory_id: int, db: Session = Depends(get_db)):
    owned(db, memory_id)
    raise HTTPException(410, detail="use_two_step_image_flow")


@router.post("/{memory_id}/image/vision/accept")
def accept(memory_id: int, payload: VisionAccept, db: Session = Depends(get_db)):
    memory = owned(db, memory_id)
    db.refresh(memory, with_for_update=True)
    draft = json.loads(memory.vision_draft) if memory.vision_draft else {}
    if (draft.get("stage") != "analysis" or draft.get("draft_id") != payload.draft_id
            or draft.get("source_image_path") != memory.source_image_path
            or draft.get("version") != memory.updated_at.isoformat()):
        raise HTTPException(409, detail="stale_vision_draft")
    value = payload.draft.model_copy(update={"tags": normalize_tags(payload.draft.tags, payload.draft.summary or memory.confirmed_content, limit=4), "category": normalize_category(payload.draft.category)})
    memory.confirmed_vision = value.model_dump_json()
    if draft.get("origin_stage") != "image_full":
        memory.confirmed_image_text = draft["reviewed_text"]
    if value.summary: memory.confirmed_content = value.summary
    if payload.title is not None:
        if not payload.title.strip(): raise HTTPException(422, detail="invalid_title")
        memory.title = payload.title.strip()
    memory.category = value.category
    memory.tags = json.dumps(value.tags)
    memory.confirmation_status = "accepted"
    memory.vision_draft = None
    db.commit(); db.refresh(memory)
    return to_read(memory)


@router.delete("/{memory_id}/image/vision", status_code=204)
def reject(memory_id: int, db: Session = Depends(get_db)):
    memory = owned(db, memory_id)
    memory.vision_draft = None
    db.commit()
