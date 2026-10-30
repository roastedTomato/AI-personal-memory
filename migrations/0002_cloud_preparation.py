from sqlalchemy import text
STATEMENTS = [
    """ALTER TABLE memories ADD COLUMN IF NOT EXISTS operation_token VARCHAR(64)""",
    """ALTER TABLE memories ADD COLUMN IF NOT EXISTS operation_expires_at TIMESTAMP WITH TIME ZONE""",
    """
CREATE TABLE pending_clarifications (
	user_id VARCHAR(100) NOT NULL, 
	conversation_id VARCHAR(100) NOT NULL, 
	request_json TEXT NOT NULL, 
	plan_json TEXT NOT NULL, 
	expires_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	PRIMARY KEY (user_id, conversation_id)
)

""",
    """CREATE INDEX ix_pending_clarifications_expires_at ON pending_clarifications (expires_at)""",
    """
CREATE TABLE image_uploads (
	id VARCHAR(64) NOT NULL, 
	user_id VARCHAR(100) NOT NULL, 
	memory_id INTEGER NOT NULL, 
	object_key VARCHAR(500) NOT NULL, 
	filename VARCHAR(255) NOT NULL, 
	mime_type VARCHAR(100) NOT NULL, 
	size INTEGER NOT NULL, 
	expires_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	completed_path VARCHAR(500), 
	PRIMARY KEY (id), 
	UNIQUE (object_key)
)

""",
    """CREATE INDEX ix_image_uploads_user_id ON image_uploads (user_id)""",
    """CREATE INDEX ix_image_uploads_memory_id ON image_uploads (memory_id)"""
]

def upgrade(connection):
    for statement in STATEMENTS:
        connection.execute(text(statement))
