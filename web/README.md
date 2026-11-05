# AI Personal Memory Web foundation

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
allows `http://localhost:5173` and the required `Authorization` and
`Content-Type` headers for manual Memory CRUD. A future hosted Web deployment
must allow its exact origin too. The CloudFormation template accepts `WebOrigin`
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
