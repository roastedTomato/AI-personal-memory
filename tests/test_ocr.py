import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from app.services import ocr


def test_real_bilingual_ocr(tmp_path, monkeypatch):
    import shutil
    source = Path("/tmp/x.png")
    if not source.exists() or not shutil.which("tesseract"):
        pytest.skip("POC synthetic fixture or tesseract unavailable")
    monkeypatch.setenv("TESSERACT_LANGUAGES", "eng+chi_sim")
    result = ocr.recognize(source)
    assert result["status"] == "completed"
    assert "Memory Test 123" in result["text"]
    assert "中文测试" in result["text"].replace(" ", "")
    assert result["duration_ms"] >= 0


@pytest.mark.parametrize("mode,expected,error", [("empty", "no_text", None), ("failure", "failed", "recognition_failed"), ("timeout", "failed", "timeout"), ("missing", "failed", "ocr_unavailable")])
def test_ocr_failures(monkeypatch, tmp_path, mode, expected, error):
    monkeypatch.delenv("TESSERACT_LANGUAGES", raising=False)
    monkeypatch.setattr(ocr.shutil, "which", lambda _: "/test/tesseract")
    def run(args, **kwargs):
        assert isinstance(args, list) and not kwargs.get("shell", False)
        assert args[args.index("-l") + 1] == "eng"
        assert kwargs["timeout"] == 15
        if mode == "timeout": raise subprocess.TimeoutExpired(args, 15)
        if mode == "missing": raise FileNotFoundError
        return SimpleNamespace(returncode=1 if mode == "failure" else 0, stdout="")
    monkeypatch.setattr(ocr.subprocess, "run", run)
    result = ocr.recognize(tmp_path / "image.png")
    assert (result["status"], result["error"]) == (expected, error)


@pytest.mark.skipif(not os.getenv("DATABASE_URL"), reason="isolated PostgreSQL required")
def test_ocr_api_content_protection_and_fallback(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.routes import images
    from app.database import SessionLocal
    from app.models import Memory
    client = TestClient(app)
    monkeypatch.setattr(images, "UPLOAD_DIR", tmp_path)
    created = client.post("/memories", json={"title": "OCR test", "original_text": "original", "confirmed_content": "confirmed"}).json()
    mid = created["id"]
    assert client.post(f"/memories/{mid}/image", files={"image": ("test.png", b"synthetic", "image/png")}).status_code == 200
    for state, text, error in [("completed", "project meeting 中文", None), ("no_text", "", None), ("failed", "", "timeout"), ("failed", "", "recognition_failed")]:
        monkeypatch.setattr(images, "recognize", lambda _, state=state, text=text, error=error: {"status": state, "text": text, "error": error, "duration_ms": 10})
        assert client.post(f"/memories/{mid}/image/ocr").json()["status"] == state
        detail = client.get(f"/memories/{mid}").json()
        assert detail["original_text"] == "original" and detail["confirmed_content"] == "confirmed"
        assert (tmp_path / Path(detail["source_image_path"]).name).exists()
        assert client.patch(f"/memories/{mid}", json={"title": "manual save"}).status_code == 200
    draft = client.post(f"/memories/{mid}/image/parse", json={"text": "edited project text"}).json()
    assert draft["draft"]["summary"] == "edited project text"
    assert client.get(f"/memories/{mid}").json()["confirmed_content"] == "confirmed"
    assert client.patch(f"/memories/{mid}", json={"confirmed_content": draft["draft"]["summary"], "confirmation_status": "accepted"}).status_code == 200
    assert client.get(f"/memories/{mid}").json()["original_text"] == "original"
    with SessionLocal() as db:
        memory = db.get(Memory, mid)
        memory.source_image_path = "/tmp/private.png"
        db.commit()
    assert client.post(f"/memories/{mid}/image/ocr").status_code == 400
    with SessionLocal() as db:
        memory = db.get(Memory, mid)
        memory.user_id = "other-user"
        db.commit()
    assert client.post(f"/memories/{mid}/image/ocr").status_code == 404
    assert client.post(f"/memories/{mid}/image/parse", json={"text": "text"}).status_code == 404
