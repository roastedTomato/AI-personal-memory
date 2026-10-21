# AI Personal Memory

## Project

Production-oriented mobile app for storing bills, receipts, notices, and important personal documents.

## Confirmed stack

- Mobile: React Native, Expo, TypeScript
- Backend: Python, FastAPI
- Database: PostgreSQL
- Current runtime: local Expo app, FastAPI API, and PostgreSQL
- Target cloud architecture: AWS; RDS PostgreSQL, S3, Cognito (provisional), Lambda + API Gateway
- Search: PostgreSQL full-text search
- Reminders: Expo local one-time notifications

## Current status

- M0: completed
- M1: completed and accepted
- M2: completed and accepted
- M3: completed and accepted
- M4: completed and accepted
- Current milestone: M5 — AWS Cloud Integration and Deployment

## Milestones

- M2: manual memory create, list, view, edit, delete
- M3: image upload, local OCR, AI text recognition and analysis, title and field prefilling, and save after user review and editing
- M4: Memory search and tag filtering, one-time reminders, and local notifications
- M5: AWS cloud integration and deployment
- M6: security, privacy, reliability and release testing
- M7: beta testing and release
- V2: cross-device synchronization

## V1 principles

- Manual saving must work without AI.
- AI output is draft data until user confirmation.
- Preserve original sources by default; deletion is user-controlled.
- Never fabricate missing information.
- Apply privacy and security requirements throughout development.
- Keep the architecture simple for one developer.
- Use environment-based configuration.
- Do not provision billable AWS resources without explicit approval.

## Out of scope for V1

Natural-language search, RAG, recurring reminders, automatic email/SMS access, website scraping, multi-user sharing, complex offline sync, and professional legal, medical, or financial advice.

## Working rules

- Inspect existing files before changing them.
- Preserve existing user changes and do not overwrite unrelated work.
- Make focused, reversible changes.
- Do not expand milestone scope without approval.
- Run relevant tests and report only final results, failures, and unresolved issues.
- Keep documentation concise; do not record step-by-step process logs.
- Do not call the real OpenAI API from automated tests.
- Use an isolated test database; backend tests may delete Memory records.
- Never commit or log API keys, database passwords, or personal document content.
- Preserve original images and source content by default; deletion must remain user-controlled.
- Keep database changes compatible with existing data and cover them with tests.

## Validation

- Backend: `.venv/bin/pytest -q`
- Mobile type checking: `cd mobile && npm run typecheck`
- Mobile unit tests: `node --test mobile/tests/*.test.mjs`

AWS is not connected yet. Do not assume cloud resources exist, and do not provision billable resources without explicit approval.
