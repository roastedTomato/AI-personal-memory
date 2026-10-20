# AI Personal Memory

## Project

Production-oriented mobile app for storing bills, receipts, notices, and important personal documents.

## Confirmed stack

- Mobile: React Native, Expo, TypeScript
- Backend: Python, FastAPI
- Database: PostgreSQL
- Cloud: AWS; RDS PostgreSQL, S3, Cognito (provisional), Lambda + API Gateway
- Search: PostgreSQL full-text search
- Reminders: Expo local one-time notifications

## Current status

- M0: completed
- M1: completed and accepted
- Current milestone: M2 — Core Memory Management

## Milestones

- M2: manual memory create, list, view, edit, delete
- M3: camera, image upload, optional AI processing and user confirmation
- M4: keyword search and one-time reminders
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
- Make focused, reversible changes.
- Do not expand milestone scope without approval.
- Run relevant tests and report only final results, failures, and unresolved issues.
- Keep documentation concise; do not record step-by-step process logs.