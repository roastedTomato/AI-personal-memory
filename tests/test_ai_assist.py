import os

import pytest

if not os.getenv("DATABASE_URL"):
    pytest.skip("DATABASE_URL is required for PostgreSQL tests", allow_module_level=True)

from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.database import SessionLocal
from app.main import app
from app.models import Memory

client = TestClient(app)


def test_mock_ai_creates_unconfirmed_draft_without_overwriting_original():
    with SessionLocal() as db:
        db.execute(delete(Memory))
        db.commit()
    created = client.post("/memories", json={"title": "Work note", "original_text": "Project meeting tomorrow", "confirmed_content": "Project meeting tomorrow"}).json()
    response = client.post(f"/memories/{created['id']}/assist", json={"operations": ["summary", "classification", "tags"]})
    assert response.status_code == 200
    assert response.json()["ai_status"] == "succeeded"
    detail = client.get(f"/memories/{created['id']}").json()
    assert detail["original_text"] == "Project meeting tomorrow"
    assert detail["confirmation_status"] == "generated"
    assert detail["ai_status"] == "succeeded"
    assert detail["generated_content"]


def test_mock_ai_respects_ownership_boundary():
    assert client.post("/memories/999999/assist", json={}).status_code == 404
