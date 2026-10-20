import asyncio

from mangum import Mangum

from app.main import app

# The application has no startup/shutdown hooks. Disabling Mangum lifespan
# handling keeps local API Gateway event simulation compatible with Python 3.15.
_mangum_handler = Mangum(app, lifespan="off")


def handler(event, context):
    """Adapt API Gateway events, including Python 3.15 local simulation."""
    try:
        asyncio.get_event_loop()
    except RuntimeError:
        asyncio.set_event_loop(asyncio.new_event_loop())
    return _mangum_handler(event, context)

