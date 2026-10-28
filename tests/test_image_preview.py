from io import BytesIO

from PIL import Image

from app.services.image_preview import image_preview


def test_previews_are_small_cached_and_preserve_original(tmp_path):
    path = tmp_path / "synthetic.png"
    Image.effect_noise((2400, 1800), 60).convert("RGB").save(path)
    original = path.read_bytes()
    stat = path.stat()
    for variant, maximum in [("thumbnail", 256), ("preview", 1200)]:
        value = image_preview(str(path), stat.st_mtime_ns, stat.st_size, variant)
        with Image.open(BytesIO(value)) as preview:
            assert max(preview.size) <= maximum
            assert preview.format == "JPEG"
        assert len(value) < len(original)
        assert image_preview(str(path), stat.st_mtime_ns, stat.st_size, variant) is value
    assert path.read_bytes() == original


def test_image_endpoint_versions_cache_and_ownership(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.routes import images
    from app.database import SessionLocal
    from app.models import Memory
    monkeypatch.setattr(images, "UPLOAD_DIR", tmp_path)
    client = TestClient(app)
    stream = BytesIO()
    Image.new("RGB", (1600, 1200), "white").save(stream, format="PNG")
    created = client.post("/memories/from-image", files={"image": ("test.png", stream.getvalue(), "image/png")}).json()
    mid = created["id"]
    url = f"/memories/{mid}/image/file"
    params = {"variant": "thumbnail", "v": created["source_image_path"].split("/")[-1]}
    response = client.get(url, params=params)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, max-age=86400"
    assert client.get(url, params=params, headers={"If-None-Match": response.headers["etag"]}).status_code == 304
    assert client.get(url).content == stream.getvalue()
    assert client.get(url, params={"variant": "invalid"}).status_code == 422
    with SessionLocal() as db:
        db.get(Memory, mid).user_id = "other-user"
        db.commit()
    assert client.get(url, params=params).status_code == 404
