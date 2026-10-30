from sqlalchemy import text
from app.services.tags import normalize_existing_memory_tags
from app.services.categories import normalize_existing_memory_categories
INITIAL_SCHEMA = """
CREATE TABLE IF NOT EXISTS memories (
	id SERIAL NOT NULL, 
	user_id VARCHAR(100) NOT NULL, 
	title VARCHAR(200) NOT NULL, 
	original_text TEXT NOT NULL, 
	generated_content TEXT, 
	confirmed_content TEXT NOT NULL, 
	category VARCHAR(100), 
	tags TEXT NOT NULL, 
	event_date DATE, 
	due_date DATE, 
	location TEXT, 
	amount NUMERIC(12, 2), 
	currency VARCHAR(3), 
	source_type VARCHAR(50) NOT NULL, 
	confirmation_status VARCHAR(50) NOT NULL, 
	ai_status VARCHAR(50) NOT NULL, 
	ai_error VARCHAR(100), 
	ai_generated_at TIMESTAMP WITH TIME ZONE, 
	reminder_at TIMESTAMP WITH TIME ZONE, 
	reminder_notification_id VARCHAR(255), 
	source_image_path VARCHAR(500), 
	source_image_filename VARCHAR(255), 
	source_image_mime_type VARCHAR(100), 
	source_image_size INTEGER, 
	ocr_text TEXT, 
	ocr_status VARCHAR(30), 
	ocr_error VARCHAR(100), 
	ocr_duration_ms INTEGER, 
	image_text_draft TEXT, 
	confirmed_image_text TEXT, 
	vision_draft TEXT, 
	vision_metadata TEXT, 
	confirmed_vision TEXT, 
	embedding vector(1536), 
	embedding_model VARCHAR(100), 
	embedding_dimensions INTEGER, 
	embedding_text_hash VARCHAR(64), 
	embedding_status VARCHAR(20), 
	embedding_error VARCHAR(100), 
	embedding_updated_at TIMESTAMP WITH TIME ZONE, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
)

"""

def upgrade(connection):
    connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
    connection.execute(text(INITIAL_SCHEMA))
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
    connection.execute(text("CREATE INDEX IF NOT EXISTS ix_memories_user_id ON memories (user_id)"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS image_text_draft TEXT"))
    connection.execute(text("ALTER TABLE memories ADD COLUMN IF NOT EXISTS confirmed_image_text TEXT"))
    normalize_existing_memory_tags(connection)
    normalize_existing_memory_categories(connection)
