# AI Personal Memory M1.4 Local PoC

Minimal FastAPI + Mangum validation. This project uses only synthetic authentication and does not connect to AWS, PostgreSQL, or external AI services.

## Local run

```sh
POC_AUTH_TOKEN=m1-4-synthetic-token .venv/bin/uvicorn app.main:app --reload
```

## Tests

```sh
.venv/bin/pytest -q
```

