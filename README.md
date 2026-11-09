# AI Personal Memory

A web app for storing bills, receipts, notices, and other personal documents. Capture a photo, review the extracted details, and find the document later by keyword, tag, or a question.

[Open the deployed app](https://d2hi82pya3luc1.cloudfront.net/)

## Features

- **Capture and review documents.** Take a photo or upload a JPEG, PNG, or WebP image up to 10 MB. Tesseract extracts text, and OpenAI suggests structured fields with your consent. Review and edit the draft before saving.
- **Manage your Memories.** Create entries manually, edit saved fields, and open the original document from the detail view. Search by keyword or narrow the list with tags.
- **Ask your Memories.** Ask a natural-language question about confirmed records. The backend plans the query, retrieves relevant records for your account, and links the answer to its sources.
- **Schedule one-time email reminders.** Use a confirmed document date as a suggestion, choose a time, and save the reminder. Delivery uses the verified email address on your account.
- **Manage account access.** Sign up, verify your email, sign in, or reset your password through Cognito.

## Screenshots

The [live Web app](https://d2hi82pya3luc1.cloudfront.net/) shows the current interface. The earlier Expo screenshots are retained in [the screenshot archive](docs/screenshots/).

## Architecture

| Component | Role |
| --- | --- |
| React, TypeScript, and Vite | Web interface served from S3 through CloudFront |
| Amazon Cognito | Account registration, sign-in, and password recovery |
| API Gateway and AWS Lambda | FastAPI endpoints running in a Linux container with Tesseract |
| Neon PostgreSQL | Memories, confirmed fields, tags, reminders, and retrieval data |
| Private Amazon S3 | Original images, with presigned uploads and reads |
| OpenAI | Field extraction and source-grounded answers after user consent |
| EventBridge Scheduler and Amazon SES | One-time reminder scheduling and email delivery |

The browser uploads photos directly to private S3 using a short-lived presigned form. The API validates the upload before OCR and keeps Memory access scoped to the signed-in owner. Manual saving works independently of AI.

## Project structure

| Path | Contents |
| --- | --- |
| [web/](web/) | Vite frontend and Web tests |
| [app/](app/) | FastAPI routes, models, OCR, retrieval, and reminders |
| [migrations/](migrations/) | Explicit database migrations |
| [deployment/](deployment/) | Lambda container, hosting templates, and release script |
| [tests/](tests/) | Backend tests |
| [mobile/](mobile/) | Earlier React Native and Expo client, currently paused |

## Development

For local Web development, copy `web/.env.example` to `web/.env.local` and set the API URL and Cognito public configuration. Then run:

```sh
cd web
npm install
npm run dev
```

For backend database setup, migrations, and runtime configuration, see the [cloud configuration and API contract](docs/cloud-deployment.md). For Web setup and releases to the existing AWS environment, see the [Web README](web/README.md).

## Verification

Run backend checks from the project root and Web checks from `web/`.

```sh
.venv/bin/pytest -q
cd web
npm test
npm run build
```

Backend tests use disposable data and mock outbound AI calls. The Web build checks TypeScript and bundles the frontend for deployment.

## Privacy and delivery

Original images and reviewed text are retained with each Memory. AI suggestions remain drafts until confirmed, and missing details can be left blank. OpenAI keys stay in the backend. While SES is in the sandbox, the reminder recipient must also be verified in SES.

## License

No open-source license has been declared.
