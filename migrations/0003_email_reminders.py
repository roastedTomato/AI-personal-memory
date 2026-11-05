from sqlalchemy import text


STATEMENTS = [
    "ALTER TABLE memories ADD COLUMN IF NOT EXISTS reminder_delivery VARCHAR(20) NOT NULL DEFAULT 'local'",
    "ALTER TABLE memories ADD COLUMN IF NOT EXISTS reminder_timezone VARCHAR(64) NOT NULL DEFAULT 'UTC'",
    "ALTER TABLE memories ADD COLUMN IF NOT EXISTS reminder_delivery_status VARCHAR(20)",
    "ALTER TABLE memories ADD COLUMN IF NOT EXISTS reminder_delivery_attempts INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE memories ADD COLUMN IF NOT EXISTS reminder_delivery_lease_until TIMESTAMP WITH TIME ZONE",
    "ALTER TABLE memories ADD COLUMN IF NOT EXISTS reminder_next_attempt_at TIMESTAMP WITH TIME ZONE",
    "ALTER TABLE memories ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMP WITH TIME ZONE",
    "CREATE TABLE IF NOT EXISTS user_emails (user_id VARCHAR(100) PRIMARY KEY, email VARCHAR(320) NOT NULL, updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now())",
    "CREATE INDEX IF NOT EXISTS ix_memories_email_reminders_due ON memories (reminder_at, reminder_next_attempt_at) WHERE reminder_delivery = 'email' AND reminder_delivery_status IN ('pending', 'sending')",
]


def upgrade(connection):
    for statement in STATEMENTS:
        connection.execute(text(statement))
