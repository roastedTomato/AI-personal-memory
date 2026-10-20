from fastapi import FastAPI, Header, HTTPException
from sqlalchemy import text

from .auth import is_valid_synthetic_token
from .database import Base, engine
from .routes.memories import router as memories_router
from .routes.ai import router as ai_router

app = FastAPI(title="AI Personal Memory M2", version="0.2.0")
Base.metadata.create_all(bind=engine)
with engine.begin() as connection:
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS ai_status VARCHAR(50) NOT NULL DEFAULT 'idle'"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS ai_error VARCHAR(100)"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS ai_generated_at TIMESTAMP WITH TIME ZONE"))
app.include_router(memories_router)
app.include_router(ai_router)


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

