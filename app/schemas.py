from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class MemoryCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    original_text: str = Field(min_length=1)
    generated_content: str | None = None
    confirmed_content: str = Field(min_length=1)
    category: str | None = Field(default=None, max_length=100)
    tags: list[str] = Field(default_factory=list)
    source_type: str = Field(default="manual", min_length=1, max_length=50)
    confirmation_status: str = Field(default="confirmed", min_length=1, max_length=50)


class MemoryUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    original_text: str | None = Field(default=None, min_length=1)
    generated_content: str | None = None
    confirmed_content: str | None = Field(default=None, min_length=1)
    category: str | None = Field(default=None, max_length=100)
    tags: list[str] | None = None
    source_type: str | None = Field(default=None, min_length=1, max_length=50)
    confirmation_status: str | None = Field(default=None, min_length=1, max_length=50)


class MemoryRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: str
    title: str
    original_text: str
    generated_content: str | None
    confirmed_content: str
    category: str | None
    tags: list[str]
    source_type: str
    confirmation_status: str
    created_at: datetime
    updated_at: datetime

