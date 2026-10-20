from fastapi import FastAPI, Header, HTTPException

from .auth import is_valid_synthetic_token

app = FastAPI(title="AI Personal Memory M1.4 PoC", version="0.1.0")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "ai-personal-memory"}


@app.get("/protected-test")
def protected_test(authorization: str | None = Header(default=None)) -> dict[str, str | bool]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization format")
    token = authorization.removeprefix("Bearer ").strip()
    if not is_valid_synthetic_token(token):
        raise HTTPException(status_code=401, detail="Unauthorized")
    return {"status": "ok", "authenticated": True, "subject": "synthetic-user"}

