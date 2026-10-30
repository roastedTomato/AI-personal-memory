"""Tests never inherit the developer database, credentials, or upload directory."""
import os
import tempfile
from pathlib import Path
import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

_test_dir = tempfile.TemporaryDirectory(prefix='memory-tests-')
url = os.getenv('TEST_DATABASE_URL')
if url:
    parsed = make_url(url)
    if parsed.host not in {'127.0.0.1', 'localhost'} or not parsed.database or not parsed.database.startswith('memory_test_'):
        raise RuntimeError('TEST_DATABASE_URL must name a local disposable memory_test_* database')
else:
    url = f'sqlite+pysqlite:///{_test_dir.name}/isolated.sqlite'
os.environ.update(DATABASE_URL=url, APP_ENV='test', AUTH_MODE='local', STORAGE_BACKEND='local', OPENAI_API_KEY='')
os.environ.pop('MIGRATION_DATABASE_URL', None)
from app.database import Base, engine
from app.models import Memory

if engine.dialect.name == 'sqlite':
    Base.metadata.create_all(engine)
else:
    from migrations.__main__ import migrate
    migrate(url)


@pytest.fixture(autouse=True)
def isolate_uploads_and_network(monkeypatch, tmp_path):
    import urllib.request
    from app.routes import images
    from app.services import embedding, vision
    monkeypatch.setattr(images, 'UPLOAD_DIR', tmp_path)
    monkeypatch.setenv('OPENAI_API_KEY', '')
    def forbidden(*args, **kwargs):
        raise AssertionError('External network forbidden in tests')
    monkeypatch.setattr(urllib.request.OpenerDirector, 'open', forbidden)
    yield
