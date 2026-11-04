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

The browser calls Cognito and the API Gateway directly. The current API Gateway
allows `http://localhost:5173` and the required `Authorization` and
`Content-Type` headers for manual Memory CRUD. A future hosted Web deployment
must allow its exact origin too. The CloudFormation template accepts `WebOrigin`
for this setting and defines the unauthenticated preflight route.

The Web slice does not yet implement photo selection/upload, native local
notifications, or the AI image-review workflow.
