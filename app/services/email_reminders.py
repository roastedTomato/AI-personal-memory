"""Deliver one email reminder from its one-time EventBridge Scheduler event."""
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from botocore.config import Config

from .. import config
from ..database import SessionLocal
from ..models import Memory, UserEmail
from .reminder_schedule import create_reminder_schedule, delete_reminder_schedule

MAX_ATTEMPTS = 5
LEASE = timedelta(minutes=4)


def deliver_reminder(memory_id: int, schedule_name: str) -> dict[str, str]:
    if not config.SES_FROM_EMAIL or not isinstance(memory_id, int) or not schedule_name:
        return {"status": "ignored"}
    now = datetime.now(UTC)
    with SessionLocal() as db:
        memory = db.scalar(select(Memory).where(Memory.id == memory_id).with_for_update())
        if (memory is None or memory.reminder_delivery != "email"
                or memory.reminder_delivery_status not in {"pending", "sending"}
                or memory.reminder_schedule_name != schedule_name
                or memory.reminder_at is None):
            return {"status": "stale"}
        if (memory.reminder_delivery_status == "sending"
                and memory.reminder_delivery_lease_until
                and memory.reminder_delivery_lease_until > now):
            # Let Scheduler retry a transiently interrupted invocation instead
            # of acknowledging and deleting the one-time schedule too early.
            raise RuntimeError("Reminder delivery is still leased")
        due_at = max(memory.reminder_at, memory.reminder_next_attempt_at or memory.reminder_at)
        if due_at > now:
            # Scheduler has minute-level precision; if invoked early, replace the
            # completed one-time schedule with one at the persisted due time.
            replacement = create_reminder_schedule(memory.id, due_at)
            memory.reminder_schedule_name = replacement
            db.commit()
            delete_reminder_schedule(schedule_name)
            return {"status": "rescheduled"}
        recipient = db.scalar(select(UserEmail.email).where(UserEmail.user_id == memory.user_id))
        memory.reminder_delivery_status = "sending"
        memory.reminder_delivery_attempts += 1
        memory.reminder_delivery_lease_until = now + LEASE
        claim = {
            "title": memory.title,
            "reminder_at": memory.reminder_at,
            "timezone": memory.reminder_timezone,
            "recipient": recipient,
            "attempt": memory.reminder_delivery_attempts,
        }
        db.commit()

    error = None
    if not claim["recipient"]:
        error = "verified_recipient_missing"
    else:
        import boto3
        client = boto3.client("sesv2", config=Config(
            connect_timeout=2, read_timeout=4, retries={"total_max_attempts": 1},
        ))
        try:
            local_due = claim["reminder_at"].astimezone(ZoneInfo(claim["timezone"]))
            client.send_email(
                FromEmailAddress=config.SES_FROM_EMAIL,
                Destination={"ToAddresses": [claim["recipient"]]},
                Content={"Simple": {
                    "Subject": {"Data": "AI Personal Memory reminder", "Charset": "UTF-8"},
                    "Body": {"Text": {"Data": (
                        f"Your reminder is due: {claim['title']}\n"
                        f"Scheduled for {local_due.strftime('%d %b %Y at %H:%M %Z')}.\n\n"
                        "Open AI Personal Memory to review the saved details."
                    ), "Charset": "UTF-8"}},
                }},
            )
        except Exception as exc:  # Persist failure and schedule a bounded retry.
            error = type(exc).__name__

    with SessionLocal() as db:
        memory = db.scalar(select(Memory).where(
            Memory.id == memory_id,
            Memory.reminder_delivery == "email",
            Memory.reminder_delivery_status == "sending",
            Memory.reminder_schedule_name == schedule_name,
        ).with_for_update())
        if memory is None:
            return {"status": "superseded"}
        memory.reminder_delivery_lease_until = None
        if error is None:
            memory.reminder_delivery_status = "sent"
            memory.reminder_sent_at = datetime.now(UTC)
            memory.reminder_next_attempt_at = None
            memory.reminder_schedule_name = None
            db.commit()
            return {"status": "sent"}
        if error == "verified_recipient_missing" or claim["attempt"] >= MAX_ATTEMPTS:
            memory.reminder_delivery_status = "failed"
            memory.reminder_next_attempt_at = None
            memory.reminder_schedule_name = None
            db.commit()
            return {"status": "failed", "reason": error}

        retry_at = datetime.now(UTC) + timedelta(minutes=2 ** claim["attempt"])
        try:
            replacement = create_reminder_schedule(memory_id, retry_at)
        except Exception:
            memory.reminder_delivery_status = "failed"
            memory.reminder_next_attempt_at = None
            memory.reminder_schedule_name = None
            db.commit()
            return {"status": "failed", "reason": "retry_schedule_failed"}
        memory.reminder_delivery_status = "pending"
        memory.reminder_next_attempt_at = retry_at
        memory.reminder_schedule_name = replacement
        db.commit()
    delete_reminder_schedule(schedule_name)
    return {"status": "retry_scheduled"}
