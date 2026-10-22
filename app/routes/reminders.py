from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..database import get_db
from ..schemas import ReminderRead, ReminderWrite
from .memories import owned_memory

router = APIRouter(prefix="/memories", tags=["reminders"])


def validate_future(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise HTTPException(status_code=422, detail="reminder_at must include a timezone")
    normalized = value.astimezone(timezone.utc)
    if normalized <= datetime.now(timezone.utc):
        raise HTTPException(status_code=422, detail="reminder_at must be in the future")
    return normalized


@router.put("/{memory_id}/reminder", response_model=ReminderRead, status_code=status.HTTP_201_CREATED)
def set_reminder(memory_id: int, payload: ReminderWrite, db: Session = Depends(get_db)) -> ReminderRead:
    memory = owned_memory(db, memory_id)
    memory.reminder_at = validate_future(payload.reminder_at)
    memory.reminder_notification_id = payload.notification_id
    db.commit()
    db.refresh(memory)
    return ReminderRead(memory_id=memory.id, reminder_at=memory.reminder_at, notification_id=memory.reminder_notification_id)


@router.get("/{memory_id}/reminder", response_model=ReminderRead)
def get_reminder(memory_id: int, db: Session = Depends(get_db)) -> ReminderRead:
    memory = owned_memory(db, memory_id)
    if memory.reminder_at is None:
        raise HTTPException(status_code=404, detail="Reminder not found")
    return ReminderRead(memory_id=memory.id, reminder_at=memory.reminder_at, notification_id=memory.reminder_notification_id)


@router.delete("/{memory_id}/reminder", status_code=status.HTTP_204_NO_CONTENT)
def cancel_reminder(memory_id: int, db: Session = Depends(get_db)) -> None:
    memory = owned_memory(db, memory_id)
    memory.reminder_at = None
    memory.reminder_notification_id = None
    db.commit()
