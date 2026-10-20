from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Memory
from ..schemas import AIAssistRequest, AIAssistResponse, AIDraft, AIDraftField
from ..services.mock_ai import generate_draft
from .memories import owned_memory

router = APIRouter(prefix="/memories", tags=["ai-assistance"])


@router.post("/{memory_id}/assist", response_model=AIAssistResponse)
def assist_memory(memory_id: int, payload: AIAssistRequest, db: Session = Depends(get_db)) -> AIAssistResponse:
    memory = owned_memory(db, memory_id)
    try:
        result = generate_draft(memory.original_text, payload.operations)
        memory.generated_content = result.summary
        memory.ai_status = "succeeded"
        memory.ai_error = None
        memory.ai_generated_at = datetime.now(timezone.utc)
        memory.confirmation_status = "generated"
        db.commit()
        return AIAssistResponse(
            memory_id=memory.id,
            ai_status="succeeded",
            draft=AIDraft(
                summary=result.summary,
                category=AIDraftField(value=result.category, confidence=0.65, uncertain=True),
                tags=[AIDraftField(value=tag, confidence=0.65, uncertain=True) for tag in result.tags],
            ),
            warnings=result.warnings,
        )
    except Exception as exc:
        memory.ai_status = "failed"
        memory.ai_error = "mock_generation_failed"
        db.commit()
        raise HTTPException(status_code=503, detail="AI assistance unavailable") from exc
