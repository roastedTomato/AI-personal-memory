"""Create one-time EventBridge Scheduler invocations for email reminders."""
import json
from datetime import UTC, datetime
from uuid import uuid4

from botocore.config import Config

from .. import config


def _client():
    import boto3
    return boto3.client("scheduler", config=Config(
        connect_timeout=2, read_timeout=5, retries={"total_max_attempts": 2},
    ))


def create_reminder_schedule(memory_id: int, reminder_at: datetime) -> str:
    if not (config.EMAIL_REMINDER_SCHEDULE_GROUP and config.EMAIL_REMINDER_TARGET_ROLE_ARN
            and config.LAMBDA_FUNCTION_ARN):
        raise RuntimeError("Email reminder scheduling is not configured")
    name = f"memory-{memory_id}-{uuid4().hex[:20]}"
    due = reminder_at.astimezone(UTC).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%S")
    _client().create_schedule(
        Name=name,
        GroupName=config.EMAIL_REMINDER_SCHEDULE_GROUP,
        ScheduleExpression=f"at({due})",
        ScheduleExpressionTimezone="UTC",
        FlexibleTimeWindow={"Mode": "OFF"},
        ActionAfterCompletion="DELETE",
        Target={
            "Arn": config.LAMBDA_FUNCTION_ARN,
            "RoleArn": config.EMAIL_REMINDER_TARGET_ROLE_ARN,
            "Input": json.dumps({
                "source": "ai-personal-memory.email-reminder",
                "memory_id": memory_id,
                "schedule_name": name,
            }),
            "RetryPolicy": {"MaximumEventAgeInSeconds": 3600, "MaximumRetryAttempts": 5},
        },
    )
    return name


def delete_reminder_schedule(name: str | None) -> None:
    if not name or not config.EMAIL_REMINDER_SCHEDULE_GROUP:
        return
    from botocore.exceptions import ClientError
    try:
        _client().delete_schedule(Name=name, GroupName=config.EMAIL_REMINDER_SCHEDULE_GROUP)
    except ClientError as exc:
        if exc.response.get("Error", {}).get("Code") != "ResourceNotFoundException":
            raise
