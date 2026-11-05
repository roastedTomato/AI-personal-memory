from datetime import UTC, datetime
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from .. import config
from ..auth import current_user, verify_identity_token
from ..database import get_db
from ..models import UserEmail
from ..schemas import EmailReminderWrite, ReminderRead, ReminderWrite
from ..services.reminder_schedule import create_reminder_schedule, delete_reminder_schedule
from .memories import owned_memory

router = APIRouter(prefix="/memories", tags=["reminders"])
DatabaseSession = Annotated[Session, Depends(get_db)]


def validate_future(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise HTTPException(status_code=422, detail="reminder_at must include a timezone")
    normalized = value.astimezone(UTC)
    if normalized <= datetime.now(UTC):
        raise HTTPException(status_code=422, detail="reminder_at must be in the future")
    return normalized


@router.put("/{memory_id}/reminder", response_model=ReminderRead, status_code=status.HTTP_201_CREATED)
def set_reminder(memory_id: int, payload: ReminderWrite, db: DatabaseSession) -> ReminderRead:
    memory = owned_memory(db, memory_id)
    old_schedule = memory.reminder_schedule_name
    memory.reminder_at = validate_future(payload.reminder_at)
    memory.reminder_notification_id = payload.notification_id
    memory.reminder_delivery = "local"
    memory.reminder_timezone = "UTC"
    memory.reminder_delivery_status = None
    memory.reminder_delivery_attempts = 0
    memory.reminder_delivery_lease_until = None
    memory.reminder_next_attempt_at = None
    memory.reminder_sent_at = None
    memory.reminder_schedule_name = None
    db.commit()
    try:
        delete_reminder_schedule(old_schedule)
    except Exception:
        # The old event is ignored because the persisted schedule name was cleared.
        pass
    db.refresh(memory)
    return ReminderRead(memory_id=memory.id, reminder_at=memory.reminder_at, notification_id=memory.reminder_notification_id,
                        delivery=memory.reminder_delivery, delivery_status=memory.reminder_delivery_status, sent_at=memory.reminder_sent_at)


@router.put("/{memory_id}/reminder/email", response_model=ReminderRead, status_code=status.HTTP_201_CREATED)
def set_email_reminder(memory_id: int, payload: EmailReminderWrite, db: DatabaseSession) -> ReminderRead:
    if not config.SES_FROM_EMAIL:
        raise HTTPException(503, detail="Email reminders are not enabled on this deployment")
    memory = owned_memory(db, memory_id)
    if memory.confirmation_status == "draft":
        raise HTTPException(409, detail="Confirm this Memory before setting a reminder")
    subject, email = verify_identity_token(payload.identity_token)
    if subject != current_user():
        raise HTTPException(403, detail="Identity token does not match the signed-in user")
    try:
        ZoneInfo(payload.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        raise HTTPException(422, detail="Unknown timezone") from None
    reminder_at = validate_future(payload.reminder_at)
    try:
        schedule_name = create_reminder_schedule(memory.id, reminder_at)
    except Exception as exc:
        raise HTTPException(503, detail="Could not schedule the email reminder") from exc
    old_schedule = memory.reminder_schedule_name
    profile = db.get(UserEmail, subject)
    if profile is None:
        db.add(UserEmail(user_id=subject, email=email))
    else:
        profile.email = email
    memory.reminder_at = reminder_at
    memory.reminder_notification_id = None
    memory.reminder_delivery = "email"
    memory.reminder_timezone = payload.timezone
    memory.reminder_delivery_status = "pending"
    memory.reminder_delivery_attempts = 0
    memory.reminder_delivery_lease_until = None
    memory.reminder_next_attempt_at = None
    memory.reminder_sent_at = None
    memory.reminder_schedule_name = schedule_name
    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        delete_reminder_schedule(schedule_name)
        raise HTTPException(503, detail="Could not save the scheduled email reminder") from exc
    try:
        delete_reminder_schedule(old_schedule)
    except Exception:
        # The prior trigger is harmless: its schedule name will no longer match
        # the Memory record, so the Lambda handler ignores it.
        pass
    db.refresh(memory)
    return ReminderRead(memory_id=memory.id, reminder_at=memory.reminder_at, notification_id=None,
                        delivery="email", delivery_status=memory.reminder_delivery_status, sent_at=None)


@router.get("/{memory_id}/reminder", response_model=ReminderRead)
def get_reminder(memory_id: int, db: DatabaseSession) -> ReminderRead:
    memory = owned_memory(db, memory_id)
    if memory.reminder_at is None:
        raise HTTPException(status_code=404, detail="Reminder not found")
    return ReminderRead(memory_id=memory.id, reminder_at=memory.reminder_at, notification_id=memory.reminder_notification_id,
                        delivery=memory.reminder_delivery, delivery_status=memory.reminder_delivery_status, sent_at=memory.reminder_sent_at)


@router.delete("/{memory_id}/reminder", status_code=status.HTTP_204_NO_CONTENT)
def cancel_reminder(memory_id: int, db: DatabaseSession) -> None:
    memory = owned_memory(db, memory_id)
    old_schedule = memory.reminder_schedule_name
    memory.reminder_at = None
    memory.reminder_notification_id = None
    memory.reminder_delivery = "local"
    memory.reminder_timezone = "UTC"
    memory.reminder_delivery_status = None
    memory.reminder_delivery_attempts = 0
    memory.reminder_delivery_lease_until = None
    memory.reminder_next_attempt_at = None
    memory.reminder_sent_at = None
    memory.reminder_schedule_name = None
    db.commit()
    try:
        delete_reminder_schedule(old_schedule)
    except Exception:
        # A trigger racing with cancellation will see the cleared DB state.
        pass
