"""Explicit local/cloud configuration; importing never connects to a database."""
import os
from sqlalchemy.engine import make_url

APP_ENV = os.getenv("APP_ENV", "cloud" if os.getenv("AWS_LAMBDA_FUNCTION_NAME") else "local")
if APP_ENV not in {"local", "cloud", "test"}:
    raise RuntimeError("Invalid APP_ENV")
DATABASE_URL = os.environ["DATABASE_URL"]
LOCAL_USER_ID = os.getenv("LOCAL_USER_ID", "local-dev-user")
AUTH_MODE = os.getenv("AUTH_MODE", "cognito" if APP_ENV == "cloud" else "local")
STORAGE_BACKEND = os.getenv("STORAGE_BACKEND", "s3" if APP_ENV == "cloud" else "local")
COGNITO_ISSUER = os.getenv("COGNITO_ISSUER", "")
COGNITO_CLIENT_ID = os.getenv("COGNITO_CLIENT_ID", "")
S3_BUCKET = os.getenv("S3_BUCKET", "")
SES_FROM_EMAIL = os.getenv("SES_FROM_EMAIL", "")
EMAIL_REMINDER_SCHEDULE_GROUP = os.getenv("EMAIL_REMINDER_SCHEDULE_GROUP", "")
EMAIL_REMINDER_TARGET_ROLE_ARN = os.getenv("EMAIL_REMINDER_TARGET_ROLE_ARN", "")
LAMBDA_FUNCTION_ARN = os.getenv("LAMBDA_FUNCTION_ARN", "")
REQUEST_DEADLINE_SECONDS = float(os.getenv("REQUEST_DEADLINE_SECONDS", "25"))
if not 0 < REQUEST_DEADLINE_SECONDS <= 25:
    raise RuntimeError("Request deadline must be between 0 and 25 seconds")
if AUTH_MODE not in {"local", "cognito"} or STORAGE_BACKEND not in {"local", "s3"}:
    raise RuntimeError("Invalid authentication/storage mode")
if AUTH_MODE == "cognito":
    import re
    if not re.fullmatch(r"https://cognito-idp\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9-]+_[A-Za-z0-9]+", COGNITO_ISSUER) or not COGNITO_CLIENT_ID:
        raise RuntimeError("Cognito issuer and client ID are required")
if STORAGE_BACKEND == "s3" and not S3_BUCKET:
    raise RuntimeError("S3_BUCKET is required")
if APP_ENV == "cloud":
    url = make_url(DATABASE_URL)
    if AUTH_MODE != "cognito" or STORAGE_BACKEND != "s3":
        raise RuntimeError("Cloud requires Cognito and S3")
    if not url.host or not url.host.endswith(".neon.tech") or "-pooler." not in url.host or url.query.get("sslmode") not in {"require", "verify-full"}:
        raise RuntimeError("Cloud database requires a TLS Neon pooled URL")
