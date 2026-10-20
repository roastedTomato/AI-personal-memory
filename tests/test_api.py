from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "ai-personal-memory"}


def test_protected_without_token():
    response = client.get("/protected-test")
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid authorization format"


def test_protected_with_malformed_auth():
    response = client.get("/protected-test", headers={"Authorization": "Basic abc"})
    assert response.status_code == 401


def test_protected_with_invalid_token():
    response = client.get(
        "/protected-test", headers={"Authorization": "Bearer wrong-token"}
    )
    assert response.status_code == 401
    assert response.json()["detail"] == "Unauthorized"


def test_protected_with_synthetic_token():
    response = client.get(
        "/protected-test",
        headers={"Authorization": "Bearer m1-4-synthetic-token"},
    )
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "authenticated": True,
        "subject": "synthetic-user",
    }

