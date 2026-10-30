from fastapi import FastAPI, Header, HTTPException

from .auth import is_valid_synthetic_token
from .routes.ai import router as ai_router
from .routes.images import router as images_router
from .routes.memories import router as memories_router
from .routes.query import router as query_router
from .routes.reminders import router as reminders_router
from .routes.vision import router as vision_router

app = FastAPI(title="AI Personal Memory M2", version="0.2.0")
app.include_router(vision_router)
app.include_router(query_router)
app.include_router(memories_router)
app.include_router(ai_router)
app.include_router(reminders_router)
app.include_router(images_router)
from .routes.uploads import router as uploads_router
app.include_router(uploads_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "ai-personal-memory"}


@app.get("/protected-test")
def protected_test(authorization: str | None = Header(default=None)) -> dict[str, str | bool]:
    if config.APP_ENV == "cloud":
        raise HTTPException(404, detail="Not found")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization format")
    token = authorization.removeprefix("Bearer ").strip()
    if not is_valid_synthetic_token(token):
        raise HTTPException(status_code=401, detail="Unauthorized")
    return {"status": "ok", "authenticated": True, "subject": "synthetic-user"}


# Identity and deadline are established before FastAPI dispatches sync handlers.
from time import monotonic
from starlette.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from . import auth, config
from .deadline import expires
from .storage import scratch


@app.middleware('http')
async def request_context(request, call_next):
    deadline_token = expires.set(monotonic() + config.REQUEST_DEADLINE_SECONDS)
    owner_token = None
    temporary_files = []
    scratch_token = scratch.set(temporary_files)
    try:
        if request.url.path.startswith('/memories'):
            owner = (config.LOCAL_USER_ID if config.AUTH_MODE == 'local' and config.APP_ENV != 'cloud'
                     else await run_in_threadpool(auth.verify_access_token, request.headers.get('authorization')))
            owner_token = auth._owner.set(owner)
        response = await call_next(request)
        if monotonic() >= expires.get():
            return JSONResponse({"detail": "Request timed out. No paid call was retried; check saved state before trying again."}, status_code=504)
        return response
    except HTTPException as exc:
        return JSONResponse({'detail': exc.detail}, status_code=exc.status_code)
    except TimeoutError:
        return JSONResponse({'detail': 'Request timed out. No paid call was retried; check saved state before trying again.'}, status_code=504)
    finally:
        if owner_token is not None:
            auth._owner.reset(owner_token)
        expires.reset(deadline_token)
        for path in temporary_files:
            path.unlink(missing_ok=True)
        scratch.reset(scratch_token)
