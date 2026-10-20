import os

import pytest

if not os.getenv("DATABASE_URL"):
    pytest.skip("DATABASE_URL is required for PostgreSQL tests", allow_module_level=True)

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import delete  # noqa: E402

from app.database import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Memory  # noqa: E402

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

