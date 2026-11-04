"""Additive S3 transfer API; pending objects cannot become AI/OCR inputs."""
from datetime import UTC, datetime, timedelta
from io import BytesIO
from uuid import uuid4
from typing import Annotated
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from PIL import Image, UnidentifiedImageError
from sqlalchemy import select
from sqlalchemy.orm import Session
from .. import config, storage
from ..auth import current_user
from ..database import get_db
from ..models import ImageUpload, Memory
from ..services.image_preview import image_preview_bytes
from .images import owned
from .memories import to_read

router = APIRouter(prefix='/memories', tags=['image-transfers'])
DB = Annotated[Session, Depends(get_db)]


class UploadRequest(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str
    size: int = Field(gt=0, le=storage.MAX_IMAGE_SIZE)


class CompleteRequest(BaseModel):
    upload_id: str = Field(min_length=1, max_length=64)


def initiate(memory, payload, db):
    if config.STORAGE_BACKEND != 's3':
        raise HTTPException(409, detail='Use local multipart image upload')
    if payload.content_type not in storage.ALLOWED_TYPES:
        raise HTTPException(415, detail='Unsupported image type')
    uid = uuid4().hex
    key = f'pending/{current_user()}/{uid}'
    upload = storage.s3_client().generate_presigned_post(Bucket=config.S3_BUCKET, Key=key,
        Fields={'Content-Type': payload.content_type}, Conditions=[{'Content-Type': payload.content_type},
        ['content-length-range', payload.size, payload.size]], ExpiresIn=300)
    db.add(ImageUpload(id=uid, user_id=current_user(), memory_id=memory.id, object_key=key,
        filename=payload.filename, mime_type=payload.content_type, size=payload.size,
        expires_at=datetime.now(UTC) + timedelta(minutes=5)))
    memory_id = memory.id
    db.commit()
    return {'memory_id': memory_id, 'upload_id': uid, 'method': 'POST', **upload, 'expires_in': 300}


@router.post('/image-uploads', status_code=201)
def new_upload(payload: UploadRequest, db: DB):
    # Reject before creating a draft if this transport is unavailable.
    if config.STORAGE_BACKEND != 's3' or payload.content_type not in storage.ALLOWED_TYPES:
        raise HTTPException(409 if config.STORAGE_BACKEND != 's3' else 415, detail='Upload transport/type unavailable')
    memory = Memory(user_id=current_user(), title=payload.filename, original_text='', confirmed_content='',
                    category=None, tags='[]', source_type='image', confirmation_status='draft')
    db.add(memory)
    db.flush()
    return initiate(memory, payload, db)


@router.post('/{memory_id}/image/uploads', status_code=201)
def upload_for_memory(memory_id: int, payload: UploadRequest, db: DB):
    return initiate(owned(db, memory_id), payload, db)


@router.post('/{memory_id}/image/uploads/complete')
def complete_upload(memory_id: int, payload: CompleteRequest, db: DB):
    memory = owned(db, memory_id)
    record = db.scalar(select(ImageUpload).where(ImageUpload.id == payload.upload_id,
        ImageUpload.user_id == current_user(), ImageUpload.memory_id == memory_id).with_for_update())
    if record is None:
        raise HTTPException(404, detail='Upload not found')
    if record.completed_path:
        if memory.source_image_path != record.completed_path:
            raise HTTPException(409, detail='Upload superseded')
        return to_read(memory)
    if record.expires_at.replace(tzinfo=UTC) <= datetime.now(UTC):
        raise HTTPException(410, detail='Upload expired')
    client = storage.s3_client()
    try:
        head = client.head_object(Bucket=config.S3_BUCKET, Key=record.object_key)
        if head['ContentLength'] != record.size or head.get('ContentType') != record.mime_type:
            raise HTTPException(422, detail='Uploaded size or type mismatch')
        response = client.get_object(Bucket=config.S3_BUCKET, Key=record.object_key, IfMatch=head['ETag'])
        body = response['Body']
        try:
            data = body.read(storage.MAX_IMAGE_SIZE + 1)
        finally:
            body.close()
        if len(data) != record.size:
            raise HTTPException(422, detail='Uploaded size mismatch')
        with Image.open(BytesIO(data)) as image:
            if image.format != storage.ALLOWED_TYPES[record.mime_type]:
                raise HTTPException(422, detail='Uploaded image type mismatch')
            image.verify()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError):
        raise HTTPException(422, detail='Invalid image') from None
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, detail='Uploaded object unavailable; upload has not been confirmed') from None
    # Staged keys remain writable until the signature expires. Promote validated bytes
    # to a fresh key that has never been granted an upload signature.
    suffix = {'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp'}[record.mime_type]
    key = f'users/{current_user()}/originals/{memory_id}-{uuid4().hex}{suffix}'
    client.put_object(Bucket=config.S3_BUCKET, Key=key, Body=data, ContentType=record.mime_type,
                      ServerSideEncryption='AES256')
    path = f's3://{config.S3_BUCKET}/{key}'
    try:
        thumbnail = image_preview_bytes(data, 'thumbnail')
        client.put_object(Bucket=config.S3_BUCKET, Key=storage.derivative_key(path, 'thumbnail'),
                          Body=thumbnail, ContentType='image/jpeg', CacheControl='private, max-age=31536000, immutable',
                          ServerSideEncryption='AES256')
    except Exception:
        # The original remains usable; older uploads fall back to dynamic previews.
        pass
    record.completed_path = path
    memory.source_image_path = path
    memory.source_image_filename, memory.source_image_mime_type, memory.source_image_size = record.filename, record.mime_type, record.size
    memory.source_type = 'image'
    memory.vision_draft = memory.image_text_draft = None
    memory.ocr_text = memory.ocr_status = memory.ocr_error = memory.ocr_duration_ms = None
    # Previous originals are retained; replacement does not imply deletion.
    db.commit()
    db.refresh(memory)
    return to_read(memory)


@router.get('/{memory_id}/image/read')
def read_image(memory_id: int, db: DB):
    memory = owned(db, memory_id)
    if not memory.source_image_path:
        raise HTTPException(404, detail='Image not found')
    if memory.source_image_path.startswith('s3://'):
        return {'url': storage.presigned_read(memory.source_image_path), 'expires_in': 300}
    return {'url': f'/memories/{memory_id}/image/file', 'expires_in': None}
