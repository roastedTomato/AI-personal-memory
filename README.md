# AI Personal Memory M2 Local Backend

Minimal local FastAPI + PostgreSQL Memory CRUD backend. It uses a fixed local development user and does not connect to AWS or external AI services.

## Local run

```sh
export DATABASE_URL='postgresql+psycopg://memory_user:实际密码@127.0.0.1:5432/memory_dev'
.venv/bin/uvicorn app.main:app --reload
```

## Tests

```sh
.venv/bin/pytest -q
```

The API is available at `http://127.0.0.1:8000`. Use `/docs` for the local API interface.

