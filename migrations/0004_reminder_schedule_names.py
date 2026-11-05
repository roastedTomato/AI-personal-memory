from sqlalchemy import text


STATEMENTS = [
    "ALTER TABLE memories ADD COLUMN IF NOT EXISTS reminder_schedule_name VARCHAR(64)",
]


def upgrade(connection):
    for statement in STATEMENTS:
        connection.execute(text(statement))
