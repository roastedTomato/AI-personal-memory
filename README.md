# AI Personal Memory

A mobile-first personal document memory library for storing bills, receipts, notices, and other important documents that need to be found later.

The project currently runs locally with a React Native + Expo mobile app, a FastAPI backend, and PostgreSQL. The current milestone is **M5: AWS cloud integration and deployment**. AWS resources are not connected yet, and no potentially billable cloud resources will be created without explicit approval.

## Features

- Create, view, edit, and delete Memory records manually
- Import document images from the camera or photo library
- Run OCR locally while preserving the original image and recognized text
- Generate structured field drafts with OpenAI only after explicit user consent
- Review and confirm titles, dates, amounts, locations, purposes, and other fields
- Search by keywords and filter by tags
- Create one-time reminders delivered through Expo local notifications
- Ask natural-language questions about saved Memories with RAG-based AI Q&A
- Preserve original sources by default; deletion remains user-controlled
- Continue with manual editing and saving when AI recognition fails

### AI Q&A with RAG

The app now supports AI Q&A powered by RAG (Retrieval-Augmented Generation). Users can ask natural-language questions about saved and confirmed Memories, such as “Which event notices did I save last month?” or “Where is the Craftadian handmade market being held?”. The system retrieves relevant confirmed content and generates an answer grounded in the matching Memories.

The current implementation is intentionally local and single-user. Its design principles are:

- Retrieve only content that the current user is authorized to access
- Prefer user-confirmed fields and text; never treat an AI draft as a fact
- Show the Memory or original document sources used for an answer
- Clearly say when there is not enough evidence instead of guessing or filling gaps
- Keep original images preserved while allowing vector indexes or retrieval data to be deleted independently
- Keep keyword search available when embedding or answer generation fails

## Screenshots

These screenshots show the current app, including the Memory library, RAG-based AI Q&A, Memory details, and local notifications.

### Memory list

![Memory list](docs/screenshots/memory-list.jpg)

### AI Q&A

![AI Q&A](docs/screenshots/ai-qa.jpg)

### Memory details and original source

![Memory detail](docs/screenshots/memory-detail.jpg)

### Local notification

![Local reminder notification](docs/screenshots/notification-reminder.jpg)

## Architecture

```text
Expo / React Native / TypeScript
              │ HTTP + multipart upload
              ▼
FastAPI / Python
       ├── PostgreSQL: Memories, tags, reminders, and recognition status
       ├── Local OCR: Tesseract
       └── Optional AI: OpenAI (server-side only)
```

The target cloud architecture is AWS RDS PostgreSQL, S3, Cognito, and Lambda + API Gateway. The codebase includes a Lambda/Mangum adapter, but cloud deployment and resource configuration are still planned work within M5.

## Project structure

```text
app/                    FastAPI application, models, routes, and services
  routes/               Memory, image, AI, vision, and reminder endpoints
  services/             OCR, AI, tagging, and category logic
  adapters/             Lambda/Mangum adapter
mobile/                 Expo React Native application
tests/                  Backend tests
mobile/tests/           Mobile unit tests
uploads/                Local development upload directory
```

## Local development

### 1. Prepare PostgreSQL

Create a local database and user, for example `memory_dev` and `memory_user`.

### 2. Configure backend environment variables

```sh
export DATABASE_URL='postgresql+psycopg://memory_user:your-local-password@127.0.0.1:5432/memory_dev'
export LOCAL_USER_ID='local-dev-user'
```

To enable AI recognition, set the key only in the backend environment:

```sh
export OPENAI_API_KEY='your-key'
export OPENAI_VISION_MODEL='gpt-5.6-luna'
```

Never put `OPENAI_API_KEY` in `EXPO_PUBLIC_*`, mobile configuration, source files, or logs.

### 3. Start the API

```sh
.venv/bin/uvicorn app.main:app --reload
```

The API is available at `http://127.0.0.1:8000`. The health check is `/health`, and the interactive API documentation is `/docs`.

### 4. Start the Expo app

```sh
cd mobile
npm install
npm start
```

The mobile app uses `http://127.0.0.1:8000` by default. If a physical device cannot reach the computer's localhost, set `EXPO_PUBLIC_API_URL` to the computer's local network address:

```sh
EXPO_PUBLIC_API_URL=http://<computer-lan-address>:8000 npm start
```

You can also use `npm run ios`, `npm run android`, or `npm run web`.

## Tests and checks

### Memory questions

Open **Ask My Memories** on the list screen. Each request asks permission to send
the question and up to five matching confirmed records to OpenAI. Sources open
their current Memory details. Existing keyword search remains available.

`POST /memories/query` accepts `question`, `consent`, `today` (the device's local
date), optional `upcoming_only`, `event_from`, `event_to`, and `category`.
Upcoming/future and 即将/未来/接下来 also enable the upcoming filter. Other natural
language date expressions are not automatically interpreted. Dates come from
`event_date`, or the valid, non-uncertain date in `confirmed_vision`; reminder dates
are not event dates. Missing dates are excluded when filtering by event date.

Retrieval restricts records to `LOCAL_USER_ID`, skips drafts and stale embeddings,
applies date/category eligibility before vector ranking, and returns up to five
matches with cosine similarity >= 0.25 (an initial, uncalibrated threshold).
Only matching confirmed content is sent for answering. Failed generation returns
the retrieved sources. Embedding failure returns an error with keyword search
still available. `OPENAI_RAG_MODEL` controls the answering model.

This remains a local single-user implementation: `LOCAL_USER_ID` is not authenticated
identity. Do not expose it as a multi-user service before adding real authentication.
Date eligibility currently scans this user's records in Python to handle legacy
JSON dates; normalize dates and move that predicate into SQL before scaling up.

```sh
.venv/bin/pytest -q
cd mobile && npm run typecheck && npm test
```

Automated tests never call the real OpenAI API. Backend tests should use an isolated test database; tests involving Memories may clean up test records.

## Image recognition flow

1. The user selects an image from the camera or photo library.
2. The mobile app converts unsupported formats, including HEIC/HEIF, to JPEG.
3. The backend preserves the original source and creates a draft Memory.
4. Tesseract runs OCR locally.
5. OCR text is sent to OpenAI for structured analysis only after explicit user consent.
6. AI-generated titles and fields remain drafts until the user reviews and confirms them.
7. A recognition failure does not delete the image; the user can still complete and save the Memory manually.

Re-analysis is an explicit user action. Opening a saved Memory does not automatically trigger an AI request.

## Privacy and security boundaries

- AI keys must exist only in the backend environment.
- Original images and text are preserved by default; deletion requires an explicit user action.
- AI output never becomes final data automatically; recognition results require human review.
- Missing values remain empty. The system does not infer locations, addresses, or purposes from GPS or context.
- The current default is a fixed local development user and is not a production authentication design.
- Multi-user sharing, automatic email/SMS access, and complex offline synchronization are not currently included.

## Current status and roadmap

- M0–M4: Completed and accepted
- M5: AWS cloud integration and deployment, in progress
- M6: Security, privacy, reliability, and release testing
- M7: Beta testing and release
- V2: Cross-device synchronization
- RAG retrieval and AI Q&A: available in the local single-user app

V1 does not include recurring reminders, automatic email/SMS access, website scraping, multi-user sharing, or professional legal, medical, or financial advice. RAG and AI Q&A are currently available locally; production multi-user authentication and cloud deployment remain future work.

## License

No open-source license has been declared. Public redistribution is not granted by default.
