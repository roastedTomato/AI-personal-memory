# AI Personal Memory Web foundation

This is a separate React web client. It uses the existing Cognito user pool and
API Gateway URL; it does not modify or share native-only Expo storage and image
handling. The current first slice supports sign-in, Memory list/search, manual
create/edit/delete, and sign-out.

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

The browser calls Cognito and the API Gateway directly. The API must allow the
chosen web origin with CORS and permit `Authorization` and `Content-Type` headers
for the required methods. The repository's deployment template currently has no
API Gateway CORS configuration, so local sign-in can work while API calls are
blocked by the browser until the deployed API's CORS policy is configured. This
Web foundation does not change AWS infrastructure.

The Web slice does not yet implement photo selection/upload, native local
notifications, or the AI image-review workflow.
