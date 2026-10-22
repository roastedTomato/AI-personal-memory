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
- Preserve original sources by default; deletion remains user-controlled
- Continue with manual editing and saving when AI recognition fails

### Planned AI Q&A

Future versions are planned to include an AI Q&A feature powered by RAG (Retrieval-Augmented Generation). Users will be able to ask natural-language questions about their saved and confirmed Memories, such as “Which event notices did I save last month?” or “Where is the Craftadian handmade market being held?”. The system will first retrieve relevant content from the user’s own Memories, confirmed text, and structured fields, then generate an answer grounded in those sources.

This feature has not been implemented yet. The current image recognition and keyword search features are not RAG. The planned design principles are:

- Retrieve only content that the current user is authorized to access
- Prefer user-confirmed fields and text; never treat an AI draft as a fact
- Show the Memory or original document sources used for an answer
- Clearly say when there is not enough evidence instead of guessing or filling gaps
- Keep original images preserved while allowing vector indexes or retrieval data to be deleted independently
- Evaluate local vector search, managed retrieval services, and PostgreSQL extensions before selecting the final implementation

## Screenshots

These screenshots show the main flow from browsing Memories and reviewing extracted content to setting a reminder and receiving a local notification.

### Memory list

![Memory list](docs/screenshots/memory-list.jpg)

### Review extracted AI fields

![Review extracted fields](docs/screenshots/review-fields.jpg)

### Memory details and one-time reminder

![Memory detail and reminder](docs/screenshots/memory-detail-reminder.jpg)

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
export OPENAI_VISION_MODEL='gpt-4.1-nano-2025-04-14'
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
- Future: RAG retrieval and AI Q&A over personal documents

V1 does not include RAG, AI Q&A, recurring reminders, automatic email/SMS access, website scraping, multi-user sharing, or professional legal, medical, or financial advice. Natural-language Q&A is planned for a later version and does not imply that a cloud model or vector database dependency exists today.

## License

No open-source license has been declared. Public redistribution is not granted by default.
