from pathlib import Path
import hashlib
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse, Response
from PIL import UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import LOCAL_USER_ID
from ..database import get_db
from ..models import Memory
from ..schemas import MemoryRead, ImageParseRequest
from ..services.ocr import recognize
from ..services.image_preview import image_preview
from ..services.mock_ai import generate_draft
from .memories import to_read

router = APIRouter(prefix="/memories", tags=["images"])
UPLOAD_DIR = Path(__file__).resolve().parents[2] / "uploads"
MAX_IMAGE_SIZE = 10 * 1024 * 1024
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp"}


def owned(db: Session, memory_id: int) -> Memory:
    memory = db.scalar(select(Memory).where(Memory.id == memory_id, Memory.user_id == LOCAL_USER_ID))
    if memory is None:
        raise HTTPException(status_code=404, detail="Memory not found")
    return memory


@router.post("/from-image", response_model=MemoryRead, status_code=status.HTTP_201_CREATED)
def create_from_image(image: UploadFile = File(...), db: Session = Depends(get_db)) -> MemoryRead:
    if image.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=415, detail="Unsupported image type")
    data = image.file.read(MAX_IMAGE_SIZE + 1)
    if len(data) > MAX_IMAGE_SIZE:
        raise HTTPException(status_code=413, detail="Image exceeds 10 MB limit")
    if not data:
        raise HTTPException(status_code=400, detail="Image is empty")
    title = Path(image.filename or "").stem.strip()[:200] or "图片记忆"
    memory = Memory(user_id=LOCAL_USER_ID, title=title, original_text="", confirmed_content="",
                    category=None, tags="[]", source_type="image", confirmation_status="draft")
    db.add(memory)
    path = None
    try:
        db.flush()
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        suffix = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[image.content_type]
        filename = f"{memory.id}-{uuid4().hex}{suffix}"
        path = UPLOAD_DIR / filename
        path.write_bytes(data)
        memory.source_image_path = f"uploads/{filename}"
        memory.source_image_filename = (image.filename or filename)[:255]
        memory.source_image_mime_type = image.content_type
        memory.source_image_size = len(data)
        db.commit()
    except Exception:
        db.rollback()
        if path is not None: path.unlink(missing_ok=True)
        raise
    db.refresh(memory)
    return to_read(memory)


@router.get("/{memory_id}/image/file")
def image_file(memory_id: int, request: Request, variant: Literal["original", "thumbnail", "preview"] = "original", v: str | None = None, db: Session = Depends(get_db)):
    memory = owned(db, memory_id)
    path = managed_image(memory)
    stat = path.stat()
    etag = '"' + hashlib.sha256(f"{path.name}:{stat.st_mtime_ns}:{stat.st_size}:{variant}".encode()).hexdigest() + '"'
    headers = {"ETag": etag, "Cache-Control": "private, max-age=86400" if v == path.name else "private, no-cache"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    if variant == "original":
        return FileResponse(path, media_type=memory.source_image_mime_type or "application/octet-stream", headers=headers)
    try:
        content = image_preview(str(path), stat.st_mtime_ns, stat.st_size, variant)
    except (OSError, ValueError, UnidentifiedImageError):
        raise HTTPException(status_code=422, detail="Image preview unavailable") from None
    return Response(content=content, media_type="image/jpeg", headers=headers)


@router.post("/{memory_id}/image", response_model=MemoryRead)
def upload_image(memory_id: int, image: UploadFile = File(...), db: Session = Depends(get_db)) -> MemoryRead:
    memory = owned(db, memory_id)
    if image.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=415, detail="Unsupported image type")
    data = image.file.read(MAX_IMAGE_SIZE + 1)
    if len(data) > MAX_IMAGE_SIZE:
        raise HTTPException(status_code=413, detail="Image exceeds 10 MB limit")
    if not data:
        raise HTTPException(status_code=400, detail="Image is empty")
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    suffix = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}[image.content_type]
    filename = f"{memory.id}-{uuid4().hex}{suffix}"
    path = UPLOAD_DIR / filename
    path.write_bytes(data)
    if memory.source_image_path:
        old = UPLOAD_DIR / Path(memory.source_image_path).name
        if old.exists(): old.unlink()
    memory.source_image_path = f"uploads/{filename}"
    memory.source_image_filename = (image.filename or filename)[:255]
    memory.source_image_mime_type = image.content_type
    memory.source_image_size = len(data)
    memory.vision_draft = None
    memory.image_text_draft = None
    memory.source_type = "image"
    memory.ocr_text = memory.ocr_status = memory.ocr_error = memory.ocr_duration_ms = None
    db.commit(); db.refresh(memory)
    return to_read(memory)


@router.post("/{memory_id}/image/parse")
def parse_image(memory_id: int, payload: ImageParseRequest | None = None, db: Session = Depends(get_db)) -> dict:
    memory = owned(db, memory_id)
    if not memory.source_image_path:
        raise HTTPException(status_code=400, detail="No image uploaded")
    if payload is not None:
        if not payload.text.strip():
            raise HTTPException(status_code=422, detail="Text is empty")
        result = generate_draft(payload.text, ["summary", "classification", "tags"])
        return {"memory_id": memory.id, "ai_status": "generated", "draft": {
            "summary": result.summary,
            "category": {"value": result.category, "confidence": 0.65, "uncertain": True},
            "tags": [{"value": tag, "confidence": 0.65, "uncertain": True} for tag in result.tags]},
            "warnings": ["Mock Parser 草稿，未经核实；OCR 文字可能有误。", *result.warnings], "error": None}
    return {"memory_id": memory.id, "ai_status": "generated", "draft": {"summary": "本地图片已上传，等待人工确认。", "category": {"value": "未分类", "confidence": 0.2, "uncertain": True}, "tags": [{"value": "图片", "confidence": 0.95, "uncertain": False}]}, "warnings": ["当前使用本地确定性解析，不包含 OCR；请人工核对内容。"], "error": None}


@router.delete("/{memory_id}/image", status_code=status.HTTP_204_NO_CONTENT)
def delete_image(memory_id: int, db: Session = Depends(get_db)) -> None:
    memory = owned(db, memory_id)
    if memory.source_image_path:
        path = UPLOAD_DIR / Path(memory.source_image_path).name
        if path.exists(): path.unlink()
    memory.ocr_text = memory.ocr_status = memory.ocr_error = memory.ocr_duration_ms = None
    memory.vision_draft = None
    memory.image_text_draft = None
    memory.source_image_path = None; memory.source_image_filename = None; memory.source_image_mime_type = None; memory.source_image_size = None
    db.commit()


def managed_image_path(memory: Memory) -> Path:
    if not memory.source_image_path:
        raise HTTPException(status_code=400, detail="No image uploaded")
    relative = Path(memory.source_image_path)
    path = (UPLOAD_DIR / relative.name).resolve()
    if (relative.parent != Path("uploads") or path.parent != UPLOAD_DIR.resolve()
            or not path.name.startswith(f"{memory.id}-")):
        raise HTTPException(status_code=400, detail="Managed image unavailable")
    return path


def managed_image(memory: Memory) -> Path:
    path = managed_image_path(memory)
    if not path.is_file():
        raise HTTPException(status_code=400, detail="Managed image unavailable")
    return path


@router.post("/{memory_id}/image/ocr")
def recognize_image(memory_id: int, db: Session = Depends(get_db)) -> dict:
    memory = owned(db, memory_id)
    path = managed_image(memory)
    result = recognize(path)
    memory.ocr_status = result["status"]
    memory.ocr_text = result["text"]
    memory.ocr_error = result["error"]
    memory.ocr_duration_ms = result["duration_ms"]
    db.commit()
    return {"memory_id": memory.id, **result,
            "warnings": ["OCR 结果未确认，可能有识别错误；请核对或手动输入。"]}
