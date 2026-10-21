import json
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..config import LOCAL_USER_ID
from ..database import get_db
from ..models import Memory
from ..schemas import MemoryCreate, MemoryRead, MemoryUpdate
from ..services.categories import normalize_category
from ..services.tags import normalize_tags

router = APIRouter(prefix="/memories", tags=["memories"])


def to_read(memory: Memory) -> MemoryRead:
    data = {key: value for key, value in memory.__dict__.items() if not key.startswith("_")}
    data["tags"] = json.loads(memory.tags or "[]")
    return MemoryRead.model_validate(data)


def owned_memory(db: Session, memory_id: int) -> Memory:
    memory = db.scalar(select(Memory).where(Memory.id == memory_id, Memory.user_id == LOCAL_USER_ID))
    if memory is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Memory not found")
    return memory


@router.post("", response_model=MemoryRead, status_code=status.HTTP_201_CREATED)
def create_memory(payload: MemoryCreate, db: Session = Depends(get_db)) -> MemoryRead:
    values = payload.model_dump(exclude={"tags", "category"})
    memory = Memory(user_id=LOCAL_USER_ID, category=normalize_category(payload.category), **values)
    memory.tags = json.dumps(normalize_tags(payload.tags, payload.original_text + " " + payload.confirmed_content))
    db.add(memory)
    db.commit()
    db.refresh(memory)
    return to_read(memory)


@router.get("", response_model=list[MemoryRead])
def list_memories(q: str | None = Query(default=None, min_length=1, max_length=100), db: Session = Depends(get_db)) -> list[MemoryRead]:
    statement = select(Memory).where(Memory.user_id == LOCAL_USER_ID)
    if q:
        pattern = f"%{q.strip()}%"
        statement = statement.where(or_(Memory.title.ilike(pattern), Memory.original_text.ilike(pattern), Memory.confirmed_content.ilike(pattern), Memory.category.ilike(pattern), Memory.tags.ilike(pattern)))
    memories = db.scalars(statement.order_by(Memory.created_at.desc())).all()
    return [to_read(memory) for memory in memories]


@router.get("/{memory_id}", response_model=MemoryRead)
def get_memory(memory_id: int, db: Session = Depends(get_db)) -> MemoryRead:
    return to_read(owned_memory(db, memory_id))


@router.patch("/{memory_id}", response_model=MemoryRead)
def update_memory(memory_id: int, payload: MemoryUpdate, db: Session = Depends(get_db)) -> MemoryRead:
    memory = owned_memory(db, memory_id)
    values = payload.model_dump(exclude_unset=True)
    if "category" in values:
        values["category"] = normalize_category(values["category"])
    if "tags" in values:
        memory.tags = json.dumps(normalize_tags(values.pop("tags"), values.get("original_text", memory.original_text) + " " + values.get("confirmed_content", memory.confirmed_content)))
    for key, value in values.items():
        setattr(memory, key, value)
    db.commit()
    db.refresh(memory)
    return to_read(memory)


@router.delete("/{memory_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_memory(memory_id: int, db: Session = Depends(get_db)) -> None:
    memory = owned_memory(db, memory_id)
    staged = None
    image_path = None
    if memory.source_image_path:
        # Import here because image routes already use to_read from this module.
        from .images import managed_image_path
        image_path = managed_image_path(memory)
        if image_path.is_file():
            staged = image_path.with_name(f".deleting-{uuid4().hex}-{image_path.name}")
            image_path.rename(staged)
    try:
        db.delete(memory)
        db.commit()
    except Exception:
        db.rollback()
        if staged is not None and image_path is not None:
            staged.rename(image_path)
        raise
    if staged is not None:
        staged.unlink()

