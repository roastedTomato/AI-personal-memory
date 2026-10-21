# AI Personal Memory M2 Local Backend

Minimal local FastAPI + PostgreSQL Memory CRUD backend. It uses a fixed local development user with optional user-approved OpenAI image analysis. It does not connect to AWS.

## Local run

```sh
export DATABASE_URL='postgresql+psycopg://memory_user:实际密码@127.0.0.1:5432/memory_dev'
.venv/bin/uvicorn app.main:app --reload
```

## Tests

```sh
.venv/bin/pytest -q
```

The API is available at `http://127.0.0.1:8000`. Use `/docs` for the local API interface.


## Create a Memory from a photo

The home screen offers camera and photo-library actions. A selected image creates
a persisted **draft** Memory with its managed local image; no separate blank
Memory form is needed. With the user's consent, Tesseract runs locally and its
recognized text is sent once to OpenAI for structured analysis. The editable
field form appears directly; raw local OCR text is retained but not displayed.
OCR or analysis failure keeps the image draft available for manual editing.
The user confirms title and reviewed fields together using one save action.
Reopening a draft or confirmed Memory reads saved results without an AI call.
Only an explicit “使用 OpenAI 重新识别并分析” action sends the image itself to
OpenAI for one combined recognition and analysis request.

The new local endpoints are `POST /memories/from-image`, `GET
/memories/{id}/image/file`, `POST /memories/{id}/image/analyze-draft` and
`POST /memories/{id}/image/finalize`, plus the explicit image-based
`POST /memories/{id}/image/reanalyze`. The existing two-stage routes remain
available for compatibility. A recognized date and time are suggestions for the reminder form;
no reminder is scheduled until the user sets it. iOS HEIC/HEIF and other
unsupported selected formats are converted locally to JPEG before upload.

## Optional OpenAI text recognition and analysis (M3.9)

Start the backend from the same terminal that securely exports a valid
`OPENAI_API_KEY`. Never put this key in `EXPO_PUBLIC_*`, mobile configuration,
source files or logs. No new Python dependency is needed.
`OPENAI_VISION_MODEL` defaults to `gpt-4.1-nano-2025-04-14`.

The current mobile image creation flow uses local Tesseract followed by
one OpenAI text-analysis request, then a reviewed field form. A separate,
explicit re-recognition action sends the managed image once to OpenAI and
returns both a transcription draft and structured fields. Legacy two-stage
endpoints remain available for compatibility. Mock parsing remains optional.

- `POST /memories/{id}/image/recognize`: `{consent: true, request_id}`.
- `POST /memories/{id}/image/analyze`: `{consent: true, request_id, text_confirmed: true, text}`.
- `POST /memories/{id}/image/vision/accept`: `{draft_id, draft}` (reviewed fields).
- `DELETE /memories/{id}/image/vision`: reject the pending analysis draft.
- `POST /memories/{id}/image/text/save`: `{text_confirmed: true, text, source_image_path}`;
  explicit manual save without calling AI, preserves original text/image.
- The old single-step `/image/vision` POST returns 410 and makes no AI request.

Location name, address and purpose are nullable, reviewed fields: extract only
what the document explicitly says, with no GPS access or place inference.
Recognition and reviewed text use separate `image_text_draft` and
`confirmed_image_text` columns. The latter is persisted only after explicit save.

Limits: one global in-flight request, 15-second cooldown for the same stage on
one Memory, 5 MB image, low image detail, 3,000 recognition output tokens,
1,200 analysis output tokens, 12,000 text characters, 30-second network timeout,
no automatic retries or provider fallback. The last request ID is deduplicated
and cannot be reused for different stages or text.
Model, usage, duration and sanitized errors are stored separately from draft data.
These controls do not enforce an account-wide USD 5 spending cap; monitor API usage.

Draft and confirmed visual fields are separate nullable JSON text columns on
`memories`, initialized using the existing startup ALTER TABLE strategy. Only
explicit acceptance changes final fields; stale drafts are rejected. No reminder
is created. Original text and image are preserved. Missing values stay null;
model extraction can still be wrong and requires human review.

Tests mock OpenAI responses and must use an isolated database: existing CRUD
tests delete Memory rows. Phone notification delivery and visual review still
require manual testing. No live API test is included in the automatic suite.
