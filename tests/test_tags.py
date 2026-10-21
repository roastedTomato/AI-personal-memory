import json

from sqlalchemy import text

from app.services.tags import canonical_tag, normalize_existing_memory_tags, normalize_tags


def test_tag_normalization_examples():
    assert canonical_tag(" December ") is None
    assert canonical_tag("Weekly") is None
    assert normalize_tags(["handmade", " Handmade ", "HAND MADE", "Wonders", "Wonder opportunity", "December", "Weekly", "2026-12", "notes"], "A handmade Wonder opportunity") == ["handmade", "wonder"]
    assert normalize_tags(["旅行", " 旅行 ", "Travel", "travels"]) == ["旅行", "travel"]
    assert normalize_tags(["Wonders", "Opportunity"], "A Wonder opportunity this week") == ["wonder"]
    assert normalize_tags(["Markets", "Market Days"]) == ["market"]


def test_existing_tag_cleanup_only_changes_tag_data():
    from app.database import engine
    with engine.begin() as connection:
        result = connection.execute(text("INSERT INTO memories (user_id, title, original_text, confirmed_content, category, tags, source_type, confirmation_status, ai_status, confirmed_vision, reminder_at) VALUES ('local-dev-user', 'keep title', 'original', 'confirmed', 'kept-category', :tags, 'image', 'accepted', 'idle', :vision, TIMESTAMPTZ '2030-12-01 10:00:00+00') RETURNING id"), {"tags": json.dumps(["Handmade", "handmade", "December", "Wonders", "Wonder opportunity"]), "vision": json.dumps({"summary": "kept summary", "tags": ["Handmade", "handmade", "Weekly"]})})
        memory_id = result.scalar_one()
        assert normalize_existing_memory_tags(connection) == 1
        assert normalize_existing_memory_tags(connection) == 0
        row = connection.execute(text("SELECT title, original_text, confirmed_content, category, tags, confirmed_vision, reminder_at FROM memories WHERE id = :id"), {"id": memory_id}).mappings().one()
        assert row["title"] == "keep title" and row["original_text"] == "original"
        assert row["confirmed_content"] == "confirmed" and row["category"] == "kept-category"
        assert row["reminder_at"].isoformat() == "2030-12-01T10:00:00+00:00"
        assert json.loads(row["tags"]) == ["handmade", "wonder"]
        assert json.loads(row["confirmed_vision"])["tags"] == ["handmade"]


def test_create_and_update_normalize_tags():
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    created = client.post("/memories", json={"title": "Tags", "original_text": "Wonder opportunity", "confirmed_content": "confirmed", "tags": ["Wonders", "Wonder opportunity", "December", "Weekly"]})
    assert created.status_code == 201
    assert created.json()["tags"] == ["wonder"]
    updated = client.patch(f"/memories/{created.json()['id']}", json={"tags": ["Handmade", "handmade", "Monthly"], "confirmed_content": "new content"})
    assert updated.status_code == 200
    assert updated.json()["tags"] == ["handmade"]
    assert updated.json()["confirmed_content"] == "new content"
