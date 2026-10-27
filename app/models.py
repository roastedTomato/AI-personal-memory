from datetime import date, datetime

from sqlalchemy import Date, DateTime, Numeric, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.types import UserDefinedType

from .database import Base


class EmbeddingVector(UserDefinedType):
    cache_ok = True

    def get_col_spec(self, **kw):
        return "vector(1536)"


class Memory(Base):
    __tablename__ = "memories"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str] = mapped_column(String(100), index=True)
    title: Mapped[str] = mapped_column(String(200))
    original_text: Mapped[str] = mapped_column(Text)
    generated_content: Mapped[str | None] = mapped_column(Text, nullable=True)
    confirmed_content: Mapped[str] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String(100), nullable=True)
    tags: Mapped[str] = mapped_column(Text, default="")
    event_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    location: Mapped[str | None] = mapped_column(Text, nullable=True)
    amount: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    source_type: Mapped[str] = mapped_column(String(50), default="manual")
    confirmation_status: Mapped[str] = mapped_column(String(50), default="confirmed")
    ai_status: Mapped[str] = mapped_column(String(50), default="idle")
    ai_error: Mapped[str | None] = mapped_column(String(100), nullable=True)
    ai_generated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reminder_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reminder_notification_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source_image_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    source_image_filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    source_image_mime_type: Mapped[str | None] = mapped_column(String(100), nullable=True)
    source_image_size: Mapped[int | None] = mapped_column(nullable=True)
    ocr_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    ocr_status: Mapped[str | None] = mapped_column(String(30), nullable=True)
    ocr_error: Mapped[str | None] = mapped_column(String(100), nullable=True)
    ocr_duration_ms: Mapped[int | None] = mapped_column(nullable=True)
    image_text_draft: Mapped[str | None] = mapped_column(Text, nullable=True)
    confirmed_image_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    vision_draft: Mapped[str | None] = mapped_column(Text, nullable=True)
    vision_metadata: Mapped[str | None] = mapped_column(Text, nullable=True)
    confirmed_vision: Mapped[str | None] = mapped_column(Text, nullable=True)
    # The preparation Text column is converted during database initialization.
    embedding: Mapped[str | None] = mapped_column(EmbeddingVector(), nullable=True)
    embedding_model: Mapped[str | None] = mapped_column(String(100), nullable=True)
    embedding_dimensions: Mapped[int | None] = mapped_column(nullable=True)
    embedding_text_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    embedding_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    embedding_error: Mapped[str | None] = mapped_column(String(100), nullable=True)
    embedding_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

