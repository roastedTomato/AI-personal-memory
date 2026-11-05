# AI Personal Memory Web foundation

## Hosted website

URL: https://d2hi82pya3luc1.cloudfront.net

AWS stack: `ai-personal-memory-web` (`deployment/web.yaml`), region
`ap-southeast-2`. The private website bucket is
`ai-personal-memory-web-webbucket-gscxygrgjqvl`; CloudFront distribution is
`E3RHZGLPP9XWSI`. API Gateway and original-photo S3 CORS allow the hosted origin
and `http://localhost:5173`. Cognito uses direct token authentication, so this
deployment does not add OAuth callback URLs.

To publish later frontend changes, build with the production public Vite settings,
upload assets first, then upload `index.html` without caching:

```sh
npm run build
aws s3 sync dist/ s3://ai-personal-memory-web-webbucket-gscxygrgjqvl/ --exclude index.html --cache-control 'public,max-age=31536000,immutable' --profile m15-deploy --region ap-southeast-2
aws s3 cp dist/index.html s3://ai-personal-memory-web-webbucket-gscxygrgjqvl/index.html --cache-control 'no-cache,no-store,must-revalidate' --content-type 'text/html; charset=utf-8' --profile m15-deploy --region ap-southeast-2
aws cloudfront create-invalidation --distribution-id E3RHZGLPP9XWSI --paths '/index.html' '/' --profile m15-deploy
```

Keep old hashed assets for open browser sessions. Frontend hosting does not
require running Vite or Docker on the user's computer. Backend changes still
require a separate Lambda image deployment.

This is a separate React web client. It uses the existing Cognito user pool and
API Gateway URL; it does not modify or share native-only Expo storage and image
handling. It supports sign-in, Memory list/search, manual create/edit/delete,
photo upload and preview, and sign-out.

## Run locally

1. Install the dependencies with `npm install` in this directory.
2. Copy `.env.example` to `.env.local` and set the deployed API URL, Cognito
   region, user-pool ID, and public app-client ID.
3. Start the client with `npm run dev`.

The browser keeps the access token in memory and the refresh token in
`sessionStorage`, which is cleared when the tab session ends. Never put passwords
or AWS secrets in the Vite environment; `VITE_*` values are included in the
browser bundle.

## Cloud prerequisite

The browser calls Cognito and the API Gateway directly. The current API Gateway
allows the hosted origin and `http://localhost:5173`, including PUT requests and
the required `Authorization` and `Content-Type` headers. The backend preparation template accepts `WebOrigin`
for both API Gateway and S3 upload CORS, and defines the unauthenticated preflight
route.

After photo selection, the browser asks for consent to automatic OCR and AI
analysis, then uploads JPEG, PNG, or WebP images (up to 10 MB) to private S3
using a short-lived presigned form. OCR text is sent to OpenAI to suggest a
title, summary, category, tags, and document fields; the image itself is not sent
to OpenAI in that step. The user can edit the recognised text and suggestions.
Nothing is confirmed until the user clicks **Confirm and save**. Previews use
short-lived signed reads. Native local notifications are not part of this Web
slice. The Web UI also supports one-time email reminders, using the verified
Cognito account email. Sending requires the backend email worker and a verified
SES sender to be configured and deployed; the local UI alone does not send mail.

## Web feature parity

The web client includes read-only Memory details with original-source access,
confirmed image field editing, manual amount/currency/date/location fields,
combined keyword and tag filters, Cognito password recovery, and a separate
camera capture input (desktop browsers may show a file picker).
Reminder date suggestions require an explicit click and do not schedule mail
until the user saves a date and time. Editing a confirmed image preserves the
original text and image through the existing confirmed-image API.

Validation: `npm test` and `npm run build` in `web/`. Tests use synthetic data
and mock Cognito calls; they do not contact AWS or OpenAI. Production browser
acceptance and actual password-reset email delivery remain separate checks.

Ask your Memories is rendered above the library. It reuses `/memories/query`,
requires explicit OpenAI consent, supports clarification replies and a new
conversation, and opens cited Memories in the existing detail view. Chat history
is session-only; it is cleared on sign-out and is not stored in browser storage.
