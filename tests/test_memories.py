import os

import pytest

if not os.getenv("DATABASE_URL"):
    pytest.skip("DATABASE_URL is required for PostgreSQL tests", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete  # noqa: E402

from app.database import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Memory  # noqa: E402
from app.routes import images  # noqa: E402

client = TestClient(app)


@pytest.fixture(autouse=True)
def clean_memories():
    with SessionLocal() as db:
        db.execute(delete(Memory))
        db.commit()
    yield


def payload(title="First memory"):
    return {
        "title": title,
        "original_text": "A manually captured memory.",
        "confirmed_content": "A confirmed memory.",
        "tags": ["personal", "test"],
    }


def test_memory_crud_flow_and_ownership_boundary():
    created = client.post("/memories", json=payload()).json()
    memory_id = created["id"]
    assert created["user_id"] == "local-dev-user"
    assert created["tags"] == ["personal", "test"]

    listed = client.get("/memories")
    assert listed.status_code == 200
    assert len(listed.json()) == 1

    detail = client.get(f"/memories/{memory_id}")
    assert detail.status_code == 200

    updated = client.patch(f"/memories/{memory_id}", json={"title": "Updated"})
    assert updated.status_code == 200
    assert updated.json()["title"] == "Updated"

    assert client.get("/memories/999999").status_code == 404
    assert client.patch("/memories/999999", json={"title": "No access"}).status_code == 404
    assert client.delete("/memories/999999").status_code == 404

    assert client.delete(f"/memories/{memory_id}").status_code == 204
    assert client.get(f"/memories/{memory_id}").status_code == 404


def test_structured_fields_are_optional_and_round_trip():
    created = client.post("/memories", json=payload()).json()
    assert created["event_date"] is None and created["embedding"] is None
    updated = client.patch(f"/memories/{created['id']}", json={
        "event_date": "2030-12-01", "due_date": "2030-12-15",
        "location": "Auckland Domain", "amount": "12.50", "currency": "NZD",
    })
    assert updated.status_code == 200
    value = updated.json()
    assert value["event_date"] == "2030-12-01"
    assert value["due_date"] == "2030-12-15"
    assert value["location"] == "Auckland Domain"
    assert value["amount"] == "12.50"
    assert value["currency"] == "NZD"


def test_embedding_text_excludes_unconfirmed_and_internal_fields():
    from app.models import Memory as MemoryModel
    from app.services.embedding import build_embedding_text
    memory = MemoryModel(title="Run", confirmed_content="Community fun run", tags='["running"]',
                         confirmed_image_text="Saturday event", category="event",
                         vision_draft="secret draft", reminder_notification_id="private-id")
    text = build_embedding_text(memory)
    assert "Community fun run" in text and "Saturday event" in text
    assert "secret draft" not in text and "private-id" not in text

def test_memory_validation():
    response = client.post("/memories", json={"title": "missing required fields"})
    assert response.status_code == 422


def test_memory_keyword_search_matches_owned_content():
    client.post("/memories", json=payload("Project planning"))
    client.post("/memories", json={**payload("Private note"), "original_text": "A recipe for soup"})
    response = client.get("/memories", params={"q": "project"})
    assert response.status_code == 200
    assert [item["title"] for item in response.json()] == ["Project planning"]


def test_empty_search_returns_validation_error():
    assert client.get("/memories", params={"q": ""}).status_code == 422



def test_deleting_memory_removes_managed_image(tmp_path, monkeypatch):
    monkeypatch.setattr(images, "UPLOAD_DIR", tmp_path)
    created = client.post("/memories", json=payload()).json()
    memory_id = created["id"]
    uploaded = client.post(
        f"/memories/{memory_id}/image",
        files={"image": ("sample.png", b"test image data", "image/png")},
    )
    assert uploaded.status_code == 200
    image_path = tmp_path / uploaded.json()["source_image_path"].split("/")[-1]
    assert image_path.is_file()

    assert client.delete(f"/memories/{memory_id}").status_code == 204
    assert not image_path.exists()
    assert client.get(f"/memories/{memory_id}").status_code == 404
    assert list(tmp_path.iterdir()) == []


def test_deleting_memory_succeeds_when_image_file_is_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(images, "UPLOAD_DIR", tmp_path)
    created = client.post("/memories", json=payload()).json()
    memory_id = created["id"]
    with SessionLocal() as db:
        memory = db.get(Memory, memory_id)
        memory.source_image_path = f"uploads/{memory_id}-missing.png"
        db.commit()

    assert client.delete(f"/memories/{memory_id}").status_code == 204
    assert client.get(f"/memories/{memory_id}").status_code == 404


def test_deleting_memory_rejects_unmanaged_image_path(tmp_path, monkeypatch):
    monkeypatch.setattr(images, "UPLOAD_DIR", tmp_path)
    created = client.post("/memories", json=payload()).json()
    memory_id = created["id"]
    unrelated = tmp_path / "unrelated.png"
    unrelated.write_bytes(b"keep")
    with SessionLocal() as db:
        memory = db.get(Memory, memory_id)
        memory.source_image_path = "uploads/unrelated.png"
        db.commit()

    assert client.delete(f"/memories/{memory_id}").status_code == 400
    assert client.get(f"/memories/{memory_id}").status_code == 200
    assert unrelated.read_bytes() == b"keep"
