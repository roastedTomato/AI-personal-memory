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
    ai_status: str
    ai_error: str | None
    ai_generated_at: datetime | None
    created_at: datetime
    updated_at: datetime


class AIAssistRequest(BaseModel):
    operations: list[str] = Field(default_factory=lambda: ["summary", "classification", "tags"])


class AIDraftField(BaseModel):
    value: str
    confidence: float = Field(ge=0, le=1)
    uncertain: bool


class AIDraft(BaseModel):
    summary: str
    category: AIDraftField
    tags: list[AIDraftField]


class AIAssistResponse(BaseModel):
    memory_id: int
    ai_status: str
    draft: AIDraft | None = None
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None

