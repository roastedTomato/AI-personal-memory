import io
import json
import urllib.error
from pathlib import Path

import pytest
from app.services import vision

DRAFT = {"suggested_title": "测试账单标题", "summary": "测试账单", "category": "bill", "tags": ["test"], "amount": "12.50", "currency": "CNY", "date": "2026-10-21", "time": None, "due_date": None, "institution": "Synthetic Test", "location_name": None, "location_address": None, "location_purpose": None, "uncertain_fields": ["due_date"], "warnings": ["人工核对"]}


def response(draft=None):
    return {"status": "completed", "model": vision.DEFAULT_MODEL, "usage": {"input_tokens": 100, "output_tokens": 80, "total_tokens": 180}, "output": [{"content": [{"type": "output_text", "text": json.dumps(DRAFT if draft is None else draft)}]}]}


@pytest.mark.parametrize("field,value", [("tags", "bad"), ("summary", "x"*2001)])
def test_invalid_structured_output(field, value):
    with pytest.raises(vision.VisionError, match="invalid_output"):
        vision.parse_response(response({**DRAFT, field: value}))


def test_nullable_and_refusal():
    value = {**DRAFT, **{key: None for key in ["summary", "category", "amount", "currency", "date", "due_date", "institution"]}}
    assert vision.parse_response(response(value))["draft"]["amount"] is None
    with pytest.raises(vision.VisionError, match="refused"):
        vision.parse_response({"output": [{"content": [{"type": "refusal"}]}]})
    with pytest.raises(vision.VisionError, match="incomplete_output"):
        vision.parse_response({"status": "incomplete", "output": []})


def test_single_request_payload(monkeypatch, tmp_path):
    image = tmp_path / "image.png"; image.write_bytes(b"\x89PNG\r\n\x1a\nsynthetic")
    monkeypatch.setenv("OPENAI_API_KEY", "test-only-not-a-key")
    monkeypatch.setenv("OPENAI_VISION_MODEL", vision.DEFAULT_MODEL)
    calls = []
    class Opener:
        def open(self, request, timeout):
            calls.append(request)
            payload = json.loads(request.data)
            assert payload["store"] is False and payload["max_output_tokens"] == 3000
            assert timeout == 30 and "tools" not in payload
            assert len(payload["input"]) == 1 and len(payload["input"][0]["content"]) == 1
            assert payload["input"][0]["content"][0]["type"] == "input_image"
            return io.BytesIO(json.dumps(response({"text": "中文 English", "warnings": []})).encode())
    monkeypatch.setattr(vision.urllib.request, "build_opener", lambda *_: Opener())
    assert vision.recognize_image(image)["draft"] == {"text": "中文 English", "warnings": []}
    assert len(calls) == 1


@pytest.mark.parametrize("status,code,expected", [(401, "invalid_api_key", "authentication_failed"), (429, "insufficient_quota", "insufficient_quota"), (429, "rate_limit", "rate_limited"), (500, "error", "provider_error"), (0, "timeout", "timeout"), (0, "network", "network_error")])
def test_errors_have_no_retry(monkeypatch, tmp_path, status, code, expected):
    image = tmp_path / "image.png"; image.write_bytes(b"\x89PNG\r\n\x1a\nsynthetic")
    monkeypatch.setenv("OPENAI_API_KEY", "test-only")
    calls = []
    class Opener:
        def open(self, request, timeout):
            calls.append(1)
            if code == "timeout": raise TimeoutError
            if code == "network": raise urllib.error.URLError("network")
            raise urllib.error.HTTPError("https://api.openai.com", status, "error", {}, io.BytesIO(json.dumps({"error": {"code": code}}).encode()))
    monkeypatch.setattr(vision.urllib.request, "build_opener", lambda *_: Opener())
    with pytest.raises(vision.VisionError, match=expected): vision.recognize_image(image)
    assert len(calls) == 1


def test_image_limits(tmp_path):
    image = tmp_path / "bad.png"; image.write_bytes(b"not an image")
    with pytest.raises(vision.VisionError, match="unsupported_image"): vision.image_data(image)
    image.write_bytes(b"x" * (vision.MAX_BYTES + 1))
    with pytest.raises(vision.VisionError, match="image_size_limit"): vision.image_data(image)


def test_api_confirmation_persistence_protection(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.routes import images
    from app.routes import vision as routes
    from app.database import SessionLocal
    from app.models import Memory
    client = TestClient(app)
    monkeypatch.setattr(images, "UPLOAD_DIR", tmp_path)
    calls = []
    def analyze(text):
        calls.append(text)
        return {"draft": DRAFT, "usage": {"total_tokens": 180}, "model": vision.DEFAULT_MODEL, "duration_ms": 12}
    monkeypatch.setattr(vision, "analyze_text", analyze)
    mid = client.post("/memories", json={"title": "test", "original_text": "original", "confirmed_content": "confirmed"}).json()["id"]
    url = f"/memories/{mid}/image/analyze"
    review_url = f"/memories/{mid}/image/vision"
    client.post(f"/memories/{mid}/image", files={"image": ("test.png", b"synthetic", "image/png")})
    assert client.post(url, json={"consent": False, "text_confirmed": True, "text": "reviewed", "request_id": "a"}).status_code == 422
    result = client.post(url, json={"consent": True, "text_confirmed": True, "text": "reviewed", "request_id": "a"}).json()
    assert result["metadata"]["status"] == "generated"
    assert client.post(url, json={"consent": True, "text_confirmed": True, "text": "reviewed", "request_id": "a"}).json() == result
    assert len(calls) == 1
    assert client.post(url, json={"consent": True, "text_confirmed": True, "text": "reviewed", "request_id": "b"}).status_code == 429
    detail = client.get(f"/memories/{mid}").json()
    assert (detail["original_text"], detail["confirmed_content"], detail["reminder_at"]) == ("original", "confirmed", None)
    assert calls[0] == "reviewed"
    assert (tmp_path / Path(detail["source_image_path"]).name).exists()
    edited = {**DRAFT, "amount": "13.00"}
    assert client.post(review_url+"/accept", json={"draft_id": result["vision"]["draft_id"], "draft": edited}).status_code == 200
    detail = client.get(f"/memories/{mid}").json()
    assert json.loads(detail["confirmed_vision"])["amount"] == "13.00"
    assert detail["original_text"] == "original" and detail["reminder_at"] is None
    assert client.post(review_url+"/accept", json={"draft_id": result["vision"]["draft_id"], "draft": edited}).status_code == 409
    with SessionLocal() as db:
        memory = db.get(Memory, mid); memory.vision_metadata = None; db.commit()
    result = client.post(url, json={"consent": True, "text_confirmed": True, "text": "reviewed", "request_id": "c"}).json()
    client.patch(f"/memories/{mid}", json={"confirmed_content": "later user edit"})
    assert client.post(review_url+"/accept", json={"draft_id": result["vision"]["draft_id"], "draft": DRAFT}).status_code == 409
    assert client.delete(review_url).status_code == 204
    assert client.get(f"/memories/{mid}").json()["confirmed_content"] == "later user edit"
    routes._gate.acquire()
    try: assert client.post(url, json={"consent": True, "text_confirmed": True, "text": "reviewed", "request_id": "d"}).status_code == 409
    finally: routes._gate.release()
    with SessionLocal() as db:
        memory = db.get(Memory, mid); memory.user_id = "other"; db.commit()
    assert client.post(url, json={"consent": True, "text_confirmed": True, "text": "reviewed", "request_id": "d"}).status_code == 404
    assert client.post(review_url+"/accept", json={"draft_id": "any", "draft": DRAFT}).status_code == 404


@pytest.mark.parametrize("confirmation", ["finalize", "vision/accept"])
def test_api_provider_failure_preserves_content(monkeypatch, tmp_path, confirmation):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.routes import images
    from app.database import SessionLocal
    from app.models import Memory
    client = TestClient(app)
    monkeypatch.setattr(images, "UPLOAD_DIR", tmp_path)
    def fail(_): raise vision.VisionError("insufficient_quota")
    monkeypatch.setattr(vision, "analyze_text", fail)
    mid = client.post("/memories", json={"title": "failure", "original_text": "source", "confirmed_content": "saved"}).json()["id"]
    client.post(f"/memories/{mid}/image", files={"image": ("test.png", b"synthetic", "image/png")})
    # Keep a valid pending draft while the next provider attempt fails.
    with SessionLocal() as db:
        memory = db.get(Memory, mid)
        memory.vision_draft = json.dumps({"stage": "analysis", "draft_id": "retained", "draft": DRAFT,
            "source_image_path": memory.source_image_path, "reviewed_text": "reviewed"})
        db.commit()
        pending = json.loads(memory.vision_draft)
        pending["version"] = memory.updated_at.isoformat()
        from sqlalchemy import update
        db.execute(update(Memory).where(Memory.id == mid).values(
            vision_draft=json.dumps(pending), updated_at=memory.updated_at))
        db.commit()
    before = client.get(f"/memories/{mid}").json()
    result = client.post(f"/memories/{mid}/image/analyze", json={"consent": True, "text_confirmed": True, "text": "reviewed", "request_id": "failed"}).json()
    assert result["vision"]["draft_id"] == "retained" and result["metadata"]["error"] == "insufficient_quota"
    detail = client.get(f"/memories/{mid}").json()
    assert detail["updated_at"] == before["updated_at"]
    assert detail["original_text"] == "source" and detail["confirmed_content"] == "saved"
    assert (tmp_path / Path(detail["source_image_path"]).name).exists()
    payload = {"draft_id": "retained", "draft": DRAFT}
    if confirmation == "finalize":
        payload.update(title="reviewed title", text="reviewed", source_image_path=detail["source_image_path"])
    saved = client.post(f"/memories/{mid}/image/{confirmation}", json=payload)
    assert saved.status_code == 200
    assert client.patch(f"/memories/{mid}", json={"title": "manual still works"}).status_code == 200


@pytest.mark.parametrize("field,value", [("amount", "NaN"), ("amount", "1,234.56"), ("currency", "$"), ("date", "2026-99-01"), ("date", "21/10/2026"), ("due_date", "tomorrow"), ("time", "25:30")])
def test_invalid_optional_value_is_unknown_not_guessed(field, value):
    result = vision.parse_response(response({**DRAFT, field: value}))["draft"]
    assert result[field] is None
    assert field in result["uncertain_fields"]
    assert result["warnings"]
    assert result["summary"] == DRAFT["summary"]


def test_format_diagnostics_do_not_contain_sensitive_values():
    with pytest.raises(vision.VisionError) as caught:
        vision.parse_response(response({**DRAFT, "tags": "SENSITIVE_DOCUMENT_TEXT"}))
    assert caught.value.diagnostics == [{"field": "tags", "type": "list_type"}]
    assert "SENSITIVE" not in str(caught.value.diagnostics)
    with pytest.raises(vision.VisionError):
        vision.parse_response({"status": "completed", "model": vision.DEFAULT_MODEL, "output": []})


def test_analysis_request_contains_only_reviewed_text(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-only")
    calls = []
    class Opener:
        def open(self, request, timeout):
            payload = json.loads(request.data)
            calls.append(payload)
            assert payload["input"] == [{"role": "user", "content": [{"type": "input_text", "text": "Edited 中文. Address explicitly: Test Road 1"}]}]
            assert "input_image" not in request.data.decode() and "data:image" not in request.data.decode()
            assert "GPS" in payload["instructions"] and "explicitly stated" in payload["instructions"]
            assert vision.DOCUMENT_LANGUAGE_RULE in payload["instructions"]
            return io.BytesIO(json.dumps(response()).encode())
    monkeypatch.setattr(vision.urllib.request, "build_opener", lambda *_: Opener())
    result = vision.analyze_text("Edited 中文. Address explicitly: Test Road 1")
    assert result["draft"]["location_address"] is None
    assert len(calls) == 1


def test_two_steps_edited_text_location_and_manual_fallback(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.routes import images
    from app.database import SessionLocal
    from app.models import Memory
    client = TestClient(app)
    monkeypatch.setattr(images, "UPLOAD_DIR", tmp_path)
    calls = []
    def recognize(path):
        calls.append("recognition")
        assert path.exists()
        return {"draft": {"text": "原始识别 text", "warnings": ["未确认"]}, "model": vision.DEFAULT_MODEL, "duration_ms": 5, "usage": {"total_tokens": 30}}
    def analyze(text):
        calls.append(text)
        return {"draft": {**DRAFT, "time": "14:30", "location_name": "Test Hall", "location_address": "1 Test Road", "location_purpose": "meeting"}, "model": vision.DEFAULT_MODEL, "duration_ms": 8, "usage": {"total_tokens": 40}}
    monkeypatch.setattr(vision, "recognize_image", recognize)
    monkeypatch.setattr(vision, "analyze_text", analyze)
    mid = client.post("/memories", json={"title": "two steps", "original_text": "original", "confirmed_content": "existing"}).json()["id"]
    base = f"/memories/{mid}"
    upload = client.post(base+"/image", files={"image": ("test.png", b"synthetic", "image/png")}).json()
    assert client.post(base+"/image/vision", json={"consent": True, "request_id": "legacy"}).status_code == 410
    assert calls == []
    first = client.post(base+"/image/recognize", json={"consent": True, "request_id": "recognize"}).json()
    assert first["recognition"]["text"] == "原始识别 text"
    assert first["vision"] is None
    detail = client.get(base).json()
    assert detail["confirmed_image_text"] is None and detail["confirmed_content"] == "existing"
    edited_text = "人工修改 text: Test Hall, 1 Test Road, purpose meeting"
    payload = {"consent": True, "request_id": "analyze", "text": edited_text}
    assert client.post(base+"/image/analyze", json=payload).status_code == 422
    assert client.post(base+"/image/analyze", json={**payload, "text_confirmed": False}).status_code == 422
    assert calls == ["recognition"]
    result = client.post(base+"/image/analyze", json={**payload, "text_confirmed": True}).json()
    assert calls == ["recognition", edited_text]
    assert result["vision"]["reviewed_text"] == edited_text
    assert client.get(base).json()["confirmed_content"] == "existing"
    reviewed = {**result["vision"]["draft"], "location_address": "2 User Corrected Road"}
    saved = client.post(base+"/image/vision/accept", json={"draft_id": result["vision"]["draft_id"], "draft": reviewed}).json()
    assert saved["confirmed_image_text"] == edited_text
    assert json.loads(saved["confirmed_vision"])["location_address"] == "2 User Corrected Road"
    assert json.loads(saved["confirmed_vision"])["date"] == "2026-10-21"
    assert json.loads(saved["confirmed_vision"])["time"] == "14:30"
    assert saved["original_text"] == "original" and saved["reminder_at"] is None
    assert saved["source_image_path"] == upload["source_image_path"]
    assert (tmp_path / Path(upload["source_image_path"]).name).exists()
    # Failure keeps the user's data available and manual saving never calls OpenAI.
    def fail(_): raise vision.VisionError("timeout")
    monkeypatch.setattr(vision, "recognize_image", fail)
    with SessionLocal() as db:
        memory = db.get(Memory, mid); memory.vision_metadata = None; db.commit()
    failure = client.post(base+"/image/recognize", json={"consent": True, "request_id": "timeout"}).json()
    assert failure["metadata"]["error"] == "timeout"
    manual = client.post(base+"/image/text/save", json={"text_confirmed": True, "text": "manually written", "source_image_path": upload["source_image_path"]}).json()
    assert manual["confirmed_content"] == "manually written" and manual["original_text"] == "original"
    assert calls == ["recognition", edited_text]
    assert client.post(base+"/image/text/save", json={"text_confirmed": False, "text": "bad", "source_image_path": upload["source_image_path"]}).status_code == 422
    assert client.post(base+"/image/text/save", json={"text_confirmed": True, "text": "bad", "source_image_path": "uploads/other.png"}).status_code == 409
    with SessionLocal() as db:
        memory = db.get(Memory, mid); memory.user_id = "another-user"; db.commit()
    assert client.post(base+"/image/recognize", json={"consent": True, "request_id": "no-access"}).status_code == 404
    assert client.post(base+"/image/text/save", json={"text_confirmed": True, "text": "bad", "source_image_path": upload["source_image_path"]}).status_code == 404


def test_recognition_no_text_and_invalid_structure():
    parsed = vision.parse_response(response({"text": None, "warnings": ["未识别到文字"]}), vision.ImageTextDraft)
    assert parsed["draft"]["text"] is None
    with pytest.raises(vision.VisionError, match="invalid_output"):
        vision.parse_response(response({"summary": "wrong stage"}), vision.ImageTextDraft)


@pytest.mark.parametrize("value", ["", " "*5, "x"*12001])
def test_analysis_rejects_empty_and_oversized_input_without_network(value):
    with pytest.raises(vision.VisionError, match="invalid_text"):
        vision.analyze_text(value)


def test_direct_image_draft_ocr_analysis_and_single_confirmation(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.routes import images
    from app.database import SessionLocal
    from app.models import Memory
    client = TestClient(app)
    monkeypatch.setattr(images, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(images, "recognize", lambda _: {"status": "completed", "text": "Synthetic meeting 2030-11-20 14:30", "error": None, "duration_ms": 3})
    calls = []
    def analyze(text):
        calls.append(text)
        return {"draft": {**DRAFT, "date": "2030-11-20", "time": "14:30"}, "model": vision.DEFAULT_MODEL, "duration_ms": 4, "usage": {"total_tokens": 10}}
    monkeypatch.setattr(vision, "analyze_text", analyze)
    created = client.post("/memories/from-image", files={"image": ("sample.png", b"synthetic image", "image/png")})
    assert created.status_code == 201
    memory = created.json(); mid = memory["id"]; base = f"/memories/{mid}"
    assert memory["confirmation_status"] == "draft"
    assert memory["original_text"] == memory["confirmed_content"] == ""
    assert client.get(base + "/image/file").content == b"synthetic image"
    ocr = client.post(base + "/image/ocr").json()
    assert ocr["text"] == "Synthetic meeting 2030-11-20 14:30"
    assert client.post(base + "/image/analyze-draft", json={"consent": False, "text": ocr["text"], "request_id": "blocked"}).status_code == 422
    analyzed = client.post(base + "/image/analyze-draft", json={"consent": True, "text": ocr["text"], "request_id": "one"}).json()
    assert calls == [ocr["text"]]
    assert client.get(base).json()["confirmed_content"] == ""
    edited = {**analyzed["vision"]["draft"], "location_name": "User corrected place"}
    payload = {"title": "Edited title", "text": "User corrected OCR", "source_image_path": memory["source_image_path"], "draft_id": analyzed["vision"]["draft_id"], "draft": edited}
    assert client.post(base + "/image/finalize", json={**payload, "source_image_path": "uploads/wrong.png"}).status_code == 409
    saved = client.post(base + "/image/finalize", json=payload).json()
    assert saved["title"] == "Edited title" and saved["confirmed_image_text"] == "User corrected OCR"
    assert saved["confirmed_content"] == edited["summary"]
    assert saved["original_text"] == "" and saved["reminder_at"] is None
    assert json.loads(saved["confirmed_vision"])["location_name"] == "User corrected place"
    assert client.get(base).json()["ocr_text"] == ocr["text"]
    assert client.post(base + "/image/finalize", json=payload).status_code == 409
    with SessionLocal() as db:
        record = db.get(Memory, mid); record.user_id = "other-user"; db.commit()
    assert client.get(base + "/image/file").status_code == 404
    assert client.post(base + "/image/finalize", json=payload).status_code == 404


def test_direct_image_ai_failure_allows_manual_finalization(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.routes import images
    client = TestClient(app)
    monkeypatch.setattr(images, "UPLOAD_DIR", tmp_path)
    def fail(_): raise vision.VisionError("timeout")
    monkeypatch.setattr(vision, "analyze_text", fail)
    memory = client.post("/memories/from-image", files={"image": ("sample.png", b"synthetic image", "image/png")}).json()
    base = f"/memories/{memory['id']}"
    result = client.post(base + "/image/analyze-draft", json={"consent": True, "text": "manual text", "request_id": "timeout"}).json()
    assert result["metadata"]["error"] == "timeout"
    assert client.get(base).json()["confirmation_status"] == "draft"
    payload = {"title": "Manual", "text": "manual text", "source_image_path": memory["source_image_path"]}
    saved = client.post(base + "/image/finalize", json=payload).json()
    assert saved["confirmed_content"] == "manual text" and saved["confirmed_vision"] is None
    assert saved["source_image_path"] == memory["source_image_path"]
    assert client.get(base + "/image/file").status_code == 200


def test_combined_image_analysis_is_one_request(monkeypatch, tmp_path):
    image = tmp_path / "synthetic.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\nsynthetic")
    monkeypatch.setenv("OPENAI_API_KEY", "test-only-not-a-key")
    calls = []
    class Opener:
        def open(self, request, timeout):
            calls.append(1)
            payload = json.loads(request.data)
            assert timeout == 30 and payload["store"] is False
            assert payload["input"][0]["content"][0]["type"] == "input_image"
            assert payload["text"]["format"]["schema"]["required"]
            assert vision.DOCUMENT_LANGUAGE_RULE in payload["instructions"]
            return io.BytesIO(json.dumps(response({**DRAFT, "recognized_text": "synthetic text"})).encode())
    monkeypatch.setattr(vision.urllib.request, "build_opener", lambda *_: Opener())
    result = vision.analyze_image(image)
    assert result["draft"]["recognized_text"] == "synthetic text"
    assert result["draft"]["date"] == "2026-10-21" and result["draft"]["time"] is None
    assert len(calls) == 1


def test_explicit_image_reanalysis_preserves_confirmed_until_accept(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.routes import images
    client = TestClient(app)
    monkeypatch.setattr(images, "UPLOAD_DIR", tmp_path)
    calls = []
    def analyze_image(path):
        calls.append(path)
        return {"draft": {**DRAFT, "recognized_text": "new OCR text"}, "model": vision.DEFAULT_MODEL, "duration_ms": 10, "usage": {"total_tokens": 20}}
    monkeypatch.setattr(vision, "analyze_image", analyze_image)
    mid = client.post("/memories", json={"title": "old", "original_text": "original", "confirmed_content": "saved"}).json()["id"]
    base = f"/memories/{mid}"
    uploaded = client.post(base + "/image", files={"image": ("synthetic.png", b"synthetic", "image/png")}).json()
    assert client.post(base + "/image/reanalyze", json={"consent": False, "request_id": "x"}).status_code == 422
    assert calls == []
    result = client.post(base + "/image/reanalyze", json={"consent": True, "request_id": "one"}).json()
    assert result["recognition"]["text"] == "new OCR text"
    assert result["vision"]["draft"]["summary"] == DRAFT["summary"]
    assert result["vision"]["draft"]["suggested_title"] == DRAFT["suggested_title"]
    assert client.get(base).json()["confirmed_content"] == "saved"
    assert client.post(base + "/image/reanalyze", json={"consent": True, "request_id": "one"}).json() == result
    assert len(calls) == 1
    saved = client.post(base + "/image/vision/accept", json={"draft_id": result["vision"]["draft_id"], "draft": result["vision"]["draft"]}).json()
    assert saved["confirmed_content"] == DRAFT["summary"]
    assert saved["confirmed_image_text"] is None  # Raw transcription was not separately reviewed.
    assert saved["original_text"] == "original" and saved["source_image_path"] == uploaded["source_image_path"]


def test_combined_image_failure_keeps_existing_content(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.routes import images
    client = TestClient(app)
    monkeypatch.setattr(images, "UPLOAD_DIR", tmp_path)
    def fail(_): raise vision.VisionError("timeout")
    monkeypatch.setattr(vision, "analyze_image", fail)
    mid = client.post("/memories", json={"title": "old", "original_text": "original", "confirmed_content": "saved"}).json()["id"]
    base = f"/memories/{mid}"
    client.post(base + "/image", files={"image": ("synthetic.png", b"synthetic", "image/png")})
    result = client.post(base + "/image/reanalyze", json={"consent": True, "request_id": "one"}).json()
    assert result["metadata"]["error"] == "timeout"
    detail = client.get(base).json()
    assert detail["confirmed_content"] == "saved" and detail["vision_draft"] is None
    assert client.get(base + "/image/file").status_code == 200


def test_backend_vision_response_matches_mobile_form_contract(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.routes import images
    fixture = json.loads((Path(__file__).resolve().parents[1] / "mobile/tests/vision-response.json").read_text())
    monkeypatch.setattr(images, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(vision, "analyze_text", lambda text: {"draft": fixture["vision"]["draft"], "model": vision.DEFAULT_MODEL, "duration_ms": 4, "usage": {"total_tokens": 10}})
    client = TestClient(app)
    memory = client.post("/memories/from-image", files={"image": ("synthetic.png", b"synthetic", "image/png")}).json()
    result = client.post(f"/memories/{memory['id']}/image/analyze-draft", json={"consent": True, "text": "synthetic OCR", "request_id": "mapping"}).json()
    assert result["metadata"]["status"] == "generated"
    assert result["vision"]["draft"] == fixture["vision"]["draft"]
    assert json.loads(client.get(f"/memories/{memory['id']}").json()["vision_draft"])["draft"] == fixture["vision"]["draft"]
    assert client.get(f"/memories/{memory['id']}").json()["confirmed_content"] == ""


def test_edit_confirmed_image_prefills_and_preserves_originals(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.routes import images
    monkeypatch.setattr(images, "UPLOAD_DIR", tmp_path)
    client = TestClient(app)
    original = client.post("/memories", json={"title": "原始标题", "original_text": "原文保留", "confirmed_content": "旧内容"}).json()
    mid = original["id"]
    uploaded = client.post(f"/memories/{mid}/image", files={"image": ("synthetic.png", b"synthetic", "image/png")}).json()
    from app.database import SessionLocal
    from app.models import Memory
    with SessionLocal() as db:
        memory = db.get(Memory, mid)
        memory.confirmed_vision = json.dumps(DRAFT)
        memory.confirmation_status = "accepted"
        db.commit()
    current = client.get(f"/memories/{mid}").json()
    assert json.loads(current["confirmed_vision"])["amount"] == "12.50"
    edited = {**DRAFT, "amount": "14.00", "location_name": "手动修改地点"}
    result = client.patch(f"/memories/{mid}/image/confirmed", json={"title": "新标题", "confirmed_content": "用户编辑内容", "draft": edited})
    assert result.status_code == 200
    saved = result.json()
    assert saved["title"] == "新标题" and saved["confirmed_content"] == "用户编辑内容"
    assert json.loads(saved["confirmed_vision"])["amount"] == "14.00"
    assert json.loads(saved["confirmed_vision"])["location_name"] == "手动修改地点"
    assert saved["original_text"] == "原文保留"
    assert saved["source_image_path"] == uploaded["source_image_path"]
    assert saved["reminder_at"] is None
    assert client.get(f"/memories/{mid}/image/file").content == b"synthetic"
    assert client.patch(f"/memories/{mid}/image/confirmed", json={"title": "x", "confirmed_content": "y", "draft": {**DRAFT, "date": "not a date"}}).status_code == 422
    with SessionLocal() as db:
        memory = db.get(Memory, mid)
        memory.user_id = "another-user"
        db.commit()
    assert client.patch(f"/memories/{mid}/image/confirmed", json={"title": "x", "confirmed_content": "y"}).status_code == 404


def test_manual_image_can_gain_structured_fields_on_edit(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.routes import images
    monkeypatch.setattr(images, "UPLOAD_DIR", tmp_path)
    client = TestClient(app)
    memory = client.post("/memories/from-image", files={"image": ("synthetic.png", b"synthetic", "image/png")}).json()
    base = f"/memories/{memory['id']}"
    confirmed = client.post(base + "/image/finalize", json={"title": "手动", "text": "手动内容", "source_image_path": memory["source_image_path"]}).json()
    assert confirmed["confirmed_vision"] is None
    result = client.patch(base + "/image/confirmed", json={"title": "编辑后", "confirmed_content": "结构化摘要", "draft": {**DRAFT, "summary": "结构化摘要"}})
    assert result.status_code == 200
    assert result.json()["confirmed_content"] == "结构化摘要"
    assert json.loads(result.json()["confirmed_vision"])["amount"] == "12.50"
    assert result.json()["source_image_path"] == memory["source_image_path"]


def test_ai_draft_tags_are_cleaned_before_review_and_confirmation(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.routes import images
    monkeypatch.setattr(images, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(vision, "analyze_text", lambda text: {"draft": {**DRAFT, "tags": ["Wonders", "Wonder opportunity", "December", "Weekly", "Handmade", "handmade"]}, "model": vision.DEFAULT_MODEL, "duration_ms": 4, "usage": {"total_tokens": 10}})
    client = TestClient(app)
    memory = client.post("/memories/from-image", files={"image": ("synthetic.png", b"synthetic", "image/png")}).json()
    base = f"/memories/{memory['id']}"
    result = client.post(base + "/image/analyze-draft", json={"consent": True, "text": "Wonder opportunity, handmade", "request_id": "tags"}).json()
    assert result["vision"]["draft"]["tags"] == ["wonder", "handmade"]
    saved = client.post(base + "/image/finalize", json={"title": "Tags", "source_image_path": memory["source_image_path"], "draft_id": result["vision"]["draft_id"], "draft": {**result["vision"]["draft"], "tags": ["Handmade", "handmade", "Weekly", "Wonders"]}}).json()
    assert saved["tags"] == ["handmade", "wonder"]
    assert json.loads(saved["confirmed_vision"])["tags"] == saved["tags"]


def test_ai_title_only_saves_after_confirmation(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.routes import images
    monkeypatch.setattr(images, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(vision, "analyze_text", lambda text: {"draft": DRAFT, "model": vision.DEFAULT_MODEL, "duration_ms": 4, "usage": {"total_tokens": 10}})
    client = TestClient(app)
    memory = client.post("/memories/from-image", files={"image": ("synthetic.png", b"synthetic", "image/png")}).json()
    base = f"/memories/{memory['id']}"
    result = client.post(base + "/image/analyze-draft", json={"consent": True, "text": "synthetic text", "request_id": "title"}).json()
    assert result["vision"]["draft"]["suggested_title"] == "测试账单标题"
    assert client.get(base).json()["title"] == memory["title"]
    saved = client.post(base + "/image/finalize", json={"title": "用户修改的标题", "source_image_path": memory["source_image_path"], "draft_id": result["vision"]["draft_id"], "draft": result["vision"]["draft"]}).json()
    assert saved["title"] == "用户修改的标题"
    assert saved["confirmed_content"] == DRAFT["summary"]
