import hashlib
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Any, Literal, cast
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse, Response, RedirectResponse
from .. import config, storage
from PIL import UnidentifiedImageError
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..auth import current_user
from ..database import get_db
from ..models import Memory
from ..schemas import ImageParseRequest, MemoryRead
from ..services import ocr
from ..services.image_preview import image_preview
from ..services.mock_ai import generate_draft
from .memories import to_read

router = APIRouter(prefix="/memories", tags=["images"])
UPLOAD_DIR = Path(__file__).resolve().parents[2] / "uploads"
MAX_IMAGE_SIZE = 10 * 1024 * 1024
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp"}
recognize = cast(Callable[[Path], dict[str, Any]], cast(Any, ocr).recognize)
DatabaseSession = Annotated[Session, Depends(get_db)]


def owned(db: Session, memory_id: int) -> Memory:
    memory = db.scalar(select(Memory).where(Memory.id == memory_id, Memory.user_id == current_user()))
    if memory is None:
        raise HTTPException(status_code=404, detail="Memory not found")
    return memory


@router.post("/from-image", response_model=MemoryRead, status_code=status.HTTP_201_CREATED)
def create_from_image(image: Annotated[UploadFile, File()], db: DatabaseSession) -> MemoryRead:
    if config.STORAGE_BACKEND == "s3":
        raise HTTPException(409, detail="Use presigned image uploads")
    if image.content_type not in ALLOWED_TYPES:
        raise HTTPException(status_code=415, detail="Unsupported image type")
    data = image.file.read(MAX_IMAGE_SIZE + 1)
    if len(data) > MAX_IMAGE_SIZE:
        raise HTTPException(status_code=413, detail="Image exceeds 10 MB limit")
    if not data:
        raise HTTPException(status_code=400, detail="Image is empty")
    title = Path(image.filename or "").stem.strip()[:200] or "图片记忆"
    memory = Memory(user_id=current_user(), title=title, original_text="", confirmed_content="",
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
def image_file(memory_id: int, request: Request, db: DatabaseSession, variant: Literal["original", "thumbnail", "preview"] = "original", v: str | None = None):
    memory = owned(db, memory_id)
    if memory.source_image_path and memory.source_image_path.startswith("s3://") and variant == "original":
        return RedirectResponse(storage.presigned_read(memory.source_image_path), status_code=307, headers={"Cache-Control": "no-store"})
    if memory.source_image_path and memory.source_image_path.startswith("s3://") and variant == "thumbnail":
        try:
            return RedirectResponse(storage.presigned_derivative(memory.source_image_path, variant), status_code=307,
                                    headers={"Cache-Control": "private, max-age=86400, immutable"})
        except Exception:
            pass
    source_version = Path(memory.source_image_path or "").name
    path = managed_image(memory)
    stat = path.stat()
    etag = '"' + hashlib.sha256(f"{memory.source_image_path}:{memory.source_image_size or stat.st_size}:{variant}".encode()).hexdigest() + '"'
    headers = {"ETag": etag, "Cache-Control": "private, max-age=86400, immutable" if v == source_version else "private, no-cache"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    if variant == "original":
        return FileResponse(path, media_type=memory.source_image_mime_type or "application/octet-stream", headers=headers)
    try:
        content = image_preview(str(path), stat.st_mtime_ns, stat.st_size, variant)
    except (OSError, ValueError, UnidentifiedImageError):
        raise HTTPException(status_code=422, detail="Image preview unavailable") from None
    if variant == "thumbnail" and memory.source_image_path and memory.source_image_path.startswith("s3://"):
        try:
            storage.s3_client().put_object(Bucket=config.S3_BUCKET,
                Key=storage.derivative_key(memory.source_image_path, variant), Body=content,
                ContentType="image/jpeg", CacheControl="private, max-age=31536000, immutable",
                ServerSideEncryption="AES256")
        except Exception:
            pass
    return Response(content=content, media_type="image/jpeg", headers=headers)


@router.post("/{memory_id}/image", response_model=MemoryRead)
def upload_image(memory_id: int, image: Annotated[UploadFile, File()], db: DatabaseSession) -> MemoryRead:
    memory = owned(db, memory_id)
    if config.STORAGE_BACKEND == "s3":
        raise HTTPException(409, detail="Use presigned image uploads")
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
def parse_image(memory_id: int, db: DatabaseSession, payload: ImageParseRequest | None = None) -> dict[str, Any]:
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
def delete_image(memory_id: int, db: DatabaseSession) -> None:
    memory = owned(db, memory_id)
    if memory.source_image_path:
        if memory.source_image_path.startswith("s3://"):
            storage.delete_original(memory.source_image_path)
        else:
            path = managed_image_path(memory)
            if path.exists(): path.unlink()
    memory.ocr_text = memory.ocr_status = memory.ocr_error = memory.ocr_duration_ms = None
    memory.vision_draft = None
    memory.image_text_draft = None
    memory.source_image_path = None; memory.source_image_filename = None; memory.source_image_mime_type = None; memory.source_image_size = None
    db.commit()


def managed_image_path(memory: Memory) -> Path:
    if config.STORAGE_BACKEND != "local":
        raise HTTPException(400, detail="Local image unavailable in cloud mode")
    if not memory.source_image_path:
        raise HTTPException(status_code=400, detail="No image uploaded")
    relative = Path(memory.source_image_path)
    path = (UPLOAD_DIR / relative.name).resolve()
    if (relative.parent != Path("uploads") or path.parent != UPLOAD_DIR.resolve()
            or not path.name.startswith(f"{memory.id}-")):
        raise HTTPException(status_code=400, detail="Managed image unavailable")
    return path


def managed_image(memory: Memory) -> Path:
    if not memory.source_image_path:
        raise HTTPException(status_code=400, detail="No image uploaded")
    if memory.source_image_path and memory.source_image_path.startswith("s3://"):
        return storage.materialize(memory.source_image_path)
    path = managed_image_path(memory)
    if not path.is_file():
        raise HTTPException(status_code=400, detail="Managed image unavailable")
    return path


@router.post("/{memory_id}/image/ocr")
def recognize_image(memory_id: int, db: DatabaseSession) -> dict[str, Any]:
    memory = owned(db, memory_id)
    owner, source_path, version = memory.user_id, memory.source_image_path, memory.updated_at
    db.expunge(memory)
    db.commit()  # Release the database connection before S3 download and OCR.
    path = managed_image(memory)
    result = recognize(path)
    saved = db.execute(update(Memory).where(
        Memory.id == memory_id,
        Memory.user_id == owner,
        Memory.source_image_path == source_path,
        Memory.updated_at == version,
    ).values(
        ocr_status=result["status"],
        ocr_text=result["text"],
        ocr_error=result["error"],
        ocr_duration_ms=result["duration_ms"],
    ).execution_options(synchronize_session=False))
    if saved.rowcount != 1:
        db.rollback()
        raise HTTPException(409, detail="Image changed while OCR was running")
    db.commit()
    return {"memory_id": memory.id, **result,
            "warnings": ["OCR 结果未确认，可能有识别错误；请核对或手动输入。"]}
