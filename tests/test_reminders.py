import os
from datetime import datetime, timedelta, timezone

import pytest

if not os.getenv("DATABASE_URL"):
    pytest.skip("DATABASE_URL is required for PostgreSQL tests", allow_module_level=True)

from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.database import SessionLocal
from app.main import app
from app.models import Memory

client = TestClient(app)


def test_one_time_reminder_lifecycle():
    with SessionLocal() as db:
        db.execute(delete(Memory))
        db.commit()
    memory = client.post("/memories", json={"title": "Reminder test", "original_text": "Call tomorrow", "confirmed_content": "Call tomorrow"}).json()
    first = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    response = client.put(f"/memories/{memory['id']}/reminder", json={"reminder_at": first, "notification_id": "notification-old"})
    assert response.status_code == 201
    assert response.json()["memory_id"] == memory["id"]
    assert response.json()["notification_id"] == "notification-old"
    assert client.get(f"/memories/{memory['id']}/reminder").status_code == 200
    updated = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
    changed = client.put(f"/memories/{memory['id']}/reminder", json={"reminder_at": updated, "notification_id": "notification-new"})
    assert changed.status_code == 201
    assert changed.json()["notification_id"] == "notification-new"
    detail = client.get(f"/memories/{memory['id']}").json()
    assert detail["reminder_notification_id"] == "notification-new"
    assert detail["reminder_at"] == changed.json()["reminder_at"]
    assert client.delete(f"/memories/{memory['id']}/reminder").status_code == 204
    assert client.get(f"/memories/{memory['id']}/reminder").status_code == 404
    detail = client.get(f"/memories/{memory['id']}")
    assert detail.status_code == 200
    assert detail.json()["reminder_notification_id"] is None


def test_reminder_rejects_past_or_timezone_less_time():
    memory = client.post("/memories", json={"title": "Validation", "original_text": "Text", "confirmed_content": "Text"}).json()
    assert client.put(f"/memories/{memory['id']}/reminder", json={"reminder_at": "2020-01-01T00:00:00Z"}).status_code == 422
    assert client.put(f"/memories/{memory['id']}/reminder", json={"reminder_at": "2030-01-01T00:00:00"}).status_code == 422


def test_reminder_respects_ownership_boundary():
    assert client.get("/memories/999999/reminder").status_code == 404
    assert client.delete("/memories/999999/reminder").status_code == 404
