from fastapi import FastAPI, Header, HTTPException
from sqlalchemy import text

from .auth import is_valid_synthetic_token
from .services.categories import normalize_existing_memory_categories
from .services.tags import normalize_existing_memory_tags
from .database import Base, engine
from .routes.memories import router as memories_router
from .routes.ai import router as ai_router
from .routes.reminders import router as reminders_router
from .routes.images import router as images_router

from .routes.vision import router as vision_router
from .routes.query import router as query_router

app = FastAPI(title="AI Personal Memory M2", version="0.2.0")
with engine.begin() as connection:
    connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
Base.metadata.create_all(bind=engine)
with engine.begin() as connection:
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS ai_status VARCHAR(50) NOT NULL DEFAULT 'idle'"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS ai_error VARCHAR(100)"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS ai_generated_at TIMESTAMP WITH TIME ZONE"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS reminder_at TIMESTAMP WITH TIME ZONE"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS reminder_notification_id VARCHAR(255)"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_image_path VARCHAR(500)"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_image_filename VARCHAR(255)"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_image_mime_type VARCHAR(100)"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS source_image_size INTEGER"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS ocr_text TEXT"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS ocr_status VARCHAR(30)"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS ocr_error VARCHAR(100)"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS ocr_duration_ms INTEGER"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS vision_draft TEXT"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS vision_metadata TEXT"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS confirmed_vision TEXT"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS image_text_draft TEXT"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS confirmed_image_text TEXT"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS event_date DATE"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS due_date DATE"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS location TEXT"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS amount NUMERIC(12, 2)"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS currency VARCHAR(3)"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding TEXT"))
    connection.execute(text("""DO $$ BEGIN
        IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
            WHERE attrelid='memories'::regclass AND attname='embedding') = 'text' THEN
            ALTER TABLE memories ALTER COLUMN embedding TYPE vector(1536)
                USING embedding::vector(1536);
        END IF;
    END $$"""))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(100)"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_dimensions INTEGER"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_text_hash VARCHAR(64)"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_status VARCHAR(20)"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_error VARCHAR(100)"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMP WITH TIME ZONE"))
    normalize_existing_memory_tags(connection)
    normalize_existing_memory_categories(connection)
app.include_router(vision_router)
app.include_router(query_router)
app.include_router(memories_router)
app.include_router(ai_router)
app.include_router(reminders_router)
app.include_router(images_router)


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

