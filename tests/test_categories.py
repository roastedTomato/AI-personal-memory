import json

from sqlalchemy import text

from app.services.categories import normalize_category, normalize_existing_memory_categories


def test_category_aliases_are_stable():
    assert normalize_category("Event") == "event"
    assert normalize_category("event announcement") == "event"
    assert normalize_category("活动通知") == "event"
    assert normalize_category("Invoice") == "bill"
    assert normalize_category("收据") == "receipt"
    assert normalize_category("something unexpected") == "other"
    assert normalize_category(" ") is None


def test_existing_category_cleanup_updates_category_json_only():
    from app.database import engine
    with engine.begin() as connection:
        result = connection.execute(text(
            "INSERT INTO memories (user_id, title, original_text, confirmed_content, category, tags, "
            "source_type, confirmation_status, ai_status, confirmed_vision, vision_draft, reminder_at) "
            "VALUES ('local-dev-user', 'keep title', 'original', 'confirmed', 'Event Announcement', '[]', "
            "'image', 'accepted', 'idle', :confirmed, :draft, TIMESTAMPTZ '2030-12-01 10:00:00+00') RETURNING id"
        ), {
            "confirmed": json.dumps({"summary": "keep", "category": "event announcement"}),
            "draft": json.dumps({"draft_id": "x", "draft": {"category": "活动通知"}}),
        })
        memory_id = result.scalar_one()
        assert normalize_existing_memory_categories(connection) == 1
        assert normalize_existing_memory_categories(connection) == 0
        row = connection.execute(text(
            "SELECT title, original_text, confirmed_content, category, tags, confirmed_vision, vision_draft, reminder_at "
            "FROM memories WHERE id = :id"
        ), {"id": memory_id}).mappings().one()
        assert row["category"] == "event"
        assert json.loads(row["confirmed_vision"])["category"] == "event"
        assert json.loads(row["vision_draft"])["draft"]["category"] == "event"
        assert row["title"] == "keep title" and row["original_text"] == "original"
        assert row["confirmed_content"] == "confirmed" and row["tags"] == "[]"
        assert row["reminder_at"].isoformat() == "2030-12-01T10:00:00+00:00"


def test_memory_create_and_update_normalize_category():
    from fastapi.testclient import TestClient
    from app.main import app
    client = TestClient(app)
    created = client.post("/memories", json={
        "title": "Event", "original_text": "Event announcement", "confirmed_content": "confirmed",
        "category": "Event Announcement",
    })
    assert created.status_code == 201
    assert created.json()["category"] == "event"
    updated = client.patch(f"/memories/{created.json()['id']}", json={"category": "活动通知"})
    assert updated.status_code == 200
    assert updated.json()["category"] == "event"
