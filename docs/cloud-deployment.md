# M5.1 deployment preparation

Target: Expo/Web → HTTP API Gateway → Lambda → Neon PostgreSQL + private S3;
Cognito access tokens authorize every `/memories` endpoint. Mobile Expo notifications
remain on the device; Web reminders use email when SES delivery is enabled. The existing
AWS backend is deployed independently of this CloudFormation preparation template.

## Configuration and migrations

Local defaults: `APP_ENV=local`, `AUTH_MODE=local`, `STORAGE_BACKEND=local`;
`LOCAL_USER_ID` is only a development identity. Cloud requires `APP_ENV=cloud`,
`AUTH_MODE=cognito`, `STORAGE_BACKEND=s3`, `S3_BUCKET`, `COGNITO_ISSUER`,
`COGNITO_CLIENT_ID`, and a TLS `postgresql+psycopg://` Neon **pooled** `DATABASE_URL`.
Lambda defaults to cloud mode if `APP_ENV` is absent. Cloud never falls back to
`local-dev-user`. Issuer, RS256 signature, expiry, issued-at, token use (`access`),
client ID and subject are checked. JWKS keys are cached and can rotate. Offline JWT
validation does not immediately detect token revocation; access tokens last 15 minutes.

Startup performs no database connections, DDL, normalization or backfills. Apply
forward-only numbered migrations explicitly to a chosen database:

```sh
# Set MIGRATION_DATABASE_URL securely to the chosen DIRECT target, then:
python -m migrations --apply
```

No runtime URL fallback is used. Pooler URLs are rejected. Migration versions and
an advisory transaction lock prevent concurrent/repeated upgrades. `0001` freezes
the baseline/legacy ALTERs and explicit tag/category normalization; `0002` adds
operation leases, upload records and durable clarifications. Runtime DB roles
should have DML access and sequence privileges, not schema/extension administration.
No migrations were applied to the existing local database. The updated app needs
these schema additions before database-backed use; upgrading a personal database
requires a separately approved backup/migration step. No personal data or images
are copied to cloud and no owner IDs are reassigned automatically.

Migration `0003_email_reminders` adds reminder delivery state and a user email
table. The email-reminder API verifies the Cognito ID token against the signed-in
access-token subject and accepts only a verified Cognito email. The scheduled
worker sends the Memory title, confirmed content, reminder time and location. It
retries SES failures up to five attempts with backoff; delivery is at-least-once
if a send succeeds but its database acknowledgement fails.

Cloud SQLAlchemy uses NullPool, a 5-second connect timeout and transaction-local
statement/idle timeouts. Sessions always close. OpenAI calls run outside DB
transactions. Vision uses a committed 60-second lease and checks owner, source,
version and lease before publishing results; concurrent edits return 409. A killed
invocation can leave a lease until expiry. Do not retry an uncertain paid attempt
automatically. Clarifications are single-use PostgreSQL records, owner scoped,
with 15-minute expiry and lazy cleanup; no transcript is stored.

## Additive image API

Existing local multipart endpoints and response shapes remain supported. Cloud
multipart endpoints return 409 with instructions to use presigned uploads; 10 MB
binary transfers must bypass the synchronous Lambda payload limit.

All endpoints below require a bearer access token in cloud mode:

| Endpoint | Request / response |
| --- | --- |
| `POST /memories/image-uploads` | `{filename, content_type, size}` creates an image draft and upload intent; returns `memory_id`, `upload_id`, `method: POST`, `url`, `fields`, `expires_in: 300` |
| `POST /memories/{id}/image/uploads` | Same upload intent for an owned existing Memory |
| `POST /memories/{id}/image/uploads/complete` | `{upload_id}`; returns existing `MemoryRead` after validation; repeat completion is idempotent unless superseded |
| `GET /memories/{id}/image/read` | `{url, expires_in}`; short-lived S3 GET URL or local API path |
| `GET /memories/{id}/image/file` | Original redirects to a signed S3 GET in cloud; thumbnail/preview remain authenticated API bytes |

Allowed types: JPEG, PNG, WebP; size 1 byte–10 MiB (same prior 10 MB API limit).
The presigned POST fixes key, declared MIME and exact size. Completion checks owner,
Memory, expiry, S3 metadata, actual length and decoded image format. Validated bytes
are promoted to a fresh private original key: replaying the pending upload signature
cannot overwrite a confirmed original. Pending keys are never recorded as a Memory
source and cannot enter OCR/AI. Original replacement retains prior source files.
Pending S3 objects expire after one day; originals have no automatic expiration.
Failed DB commits can leave unreferenced originals: reconcile against upload records
before any user-approved cleanup. S3 and PostgreSQL operations are not a distributed
transaction; failure/reconciliation must be tested in the deployed environment.

S3 signatures are temporary bearer access: do not log URLs or form fields. Mobile
API helpers support direct S3 forms and injectable Cognito token providers; they
never send Cognito authorization to S3. `EXPO_PUBLIC_STORAGE_BACKEND=s3` selects
cloud transfers and `EXPO_PUBLIC_APP_ENV=cloud` requires sign-in. The actual mobile
Cognito sign-in/refresh UI remains to be integrated before phone cloud acceptance.
The provider must return fresh access tokens; native API image requests carry the
latest token. `MemoryImage` resolves originals through `readMemoryImage()` and sends no API bearer token to the resulting S3 URL.

## Synchronous request budget and OCR

`REQUEST_DEADLINE_SECONDS=25` is an absolute request budget shared across classifier,
embedding, answer, Vision and OCR calls. Each provider request uses the remaining
budget; bounded response reads recheck it. Paid requests have no retry mechanism.
Budget exhaustion returns a timeout/error envelope; saving remains independent of
embedding failure. Check saved state before manually resubmitting a timed-out save.
DNS/OS scheduling and database finalization can still add overhead; deployed p95 and
timeout behavior need measurement. Do not treat the budget as cancellation of a
provider request already received by OpenAI.

`deployment/Dockerfile`: Python 3.12 Linux, Lambda runtime interface client,
Tesseract + English data/Leptonica, Pillow and psycopg. Build a single linux/amd64
image to match the template; no local credentials, uploads or documents enter the
build context. S3 inputs are bounded and materialized to request-owned `/tmp` files,
removed on success/failure. Root filesystem may remain read-only. OCR subprocess
keeps its 15-second cap (or remaining budget), English language and single-thread cap.

`deployment/template.yaml` is a CloudFormation preparation template, not deployed.
It accepts an exact `WebOrigin` (defaulting to the local Vite origin), an existing
digest-pinned ECR image, and existing Secrets Manager ARNs
(`pooled_url`, `api_key` fields), then defines private SSE-S3 storage, Cognito,
2048 MB Lambda/512 MB temporary space/29-second timeout, HTTP API and a minimal
runtime role. No VPC, NAT, RDS, remote push, sync, provisioned concurrency or keep-alive.
One-time email reminder scheduling is conditional on enabling an SES sender. Logs retain seven
days; S3/UserPool are retained on stack deletion.
HTTP API CORS allows only `WebOrigin`; an explicit unauthenticated OPTIONS route
rewrites preflight requests to the public health handler and returns 204. S3 CORS
allows browser POST uploads from that same exact origin; a hosted Web deployment
must pass its own origin for both services.

Email reminders are disabled unless `EmailSenderAddress` is set to an SES-verified
identity. When configured, the template grants `ses:SendEmail` only for that
identity and creates an EventBridge Scheduler group. The API creates a one-time
schedule for each email reminder; updating or cancelling a reminder replaces or
deletes its schedule. Failed email deliveries receive bounded, individually
scheduled retries; there is no periodic database polling.
Before deployment, verify the sender in the same AWS region; SES sandbox accounts
also require the recipient address to be verified or the account to be approved
for production sending. The sender identity, schedule group and delivery IAM
policy are not created by the current deployment. SES/Scheduler/Lambda charges and the
sender verification gate must be reviewed before enabling them.

## Verification / remaining gates

Tests force a disposable SQLite DB by default, block outbound urllib network and
use temporary upload directories. To validate PostgreSQL/pgvector/real migrations,
set `TEST_DATABASE_URL` to a local, disposable `memory_test_*` database; the suite
may delete all synthetic Memory records. It never uses the developer DATABASE_URL.

Remaining gates: install new PyJWT/cryptography/boto3 dependencies; validate real RSA
verification; run versioned migrations and legacy data compatibility on isolated
PostgreSQL/pgvector; build/run the Linux image and measure OCR memory/time; validate
CloudFormation; integrate mobile Cognito sign-in/refresh; verify AWS identity,
permissions and Budgets; explicitly approve resources before deployment. Then use
two test users and synthetic data to check isolation, S3 failure recovery, cold
Lambda + sleeping Neon latency and end-to-end deadlines. No cloud pass is claimed.

Local verification: 206 backend tests passed, 5 skipped; 11 mobile unit tests passed;
mobile typecheck, Python compilation and YAML syntax parsed successfully. This does
not validate CloudFormation resource semantics or an actual Linux/Lambda runtime.
