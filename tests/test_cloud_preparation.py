"""Local risk tests. S3 and Cognito identity are mocked; no cloud resources."""
from datetime import UTC, datetime, timedelta
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import importlib.util
import json
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import select
from app import auth, config, storage
from app.database import SessionLocal, engine
from app.main import app
from app.models import Memory, ImageUpload, PendingClarification
from app.services import vision


@pytest.fixture
def cloud_api(monkeypatch):
    monkeypatch.setattr(config, 'AUTH_MODE', 'cognito')
    monkeypatch.setattr(config, 'STORAGE_BACKEND', 's3')
    monkeypatch.setattr(config, 'S3_BUCKET', 'synthetic-test-bucket')
    def verify(header):
        if header not in {'Bearer alice', 'Bearer bob'}:
            from fastapi import HTTPException
            raise HTTPException(401, detail='Invalid token')
        return header[7:]
    monkeypatch.setattr(auth, 'verify_access_token', verify)
    return TestClient(app)


def headers(owner='alice'):
    return {'Authorization': f'Bearer {owner}'}


def memory(client, owner='alice'):
    return client.post('/memories', json={'title': 'Synthetic', 'original_text': 'Synthetic',
        'confirmed_content': 'Synthetic'}, headers=headers(owner)).json()['id']


def test_all_memory_surfaces_are_protected(cloud_api):
    mid = memory(cloud_api)
    for method, path in [('GET', ''), ('GET', f'/{mid}'), ('PATCH', f'/{mid}'),
            ('DELETE', f'/{mid}'), ('GET', f'/{mid}/image/file'), ('GET', f'/{mid}/image/read'),
            ('POST', f'/{mid}/image/ocr'), ('POST', f'/{mid}/image/recognize'), ('POST', '/query'),
            ('POST', f'/{mid}/assist'), ('GET', f'/{mid}/reminder'), ('POST', f'/{mid}/image/uploads')]:
        assert cloud_api.request(method, '/memories' + path).status_code == 401
    assert cloud_api.get(f'/memories/{mid}', headers=headers('bob')).status_code == 404
    assert all(m['user_id'] == 'bob' for m in cloud_api.get('/memories', headers=headers('bob')).json())
    for path in ['image/file', 'image/read', 'reminder']:
        assert cloud_api.get(f'/memories/{mid}/{path}', headers=headers('bob')).status_code == 404
    assert cloud_api.post(f'/memories/{mid}/image/ocr', headers=headers('bob')).status_code == 404


class FakeS3:
    def __init__(self, data, mime='image/png'):
        self.data, self.mime = data, mime
        self.puts = []
    def generate_presigned_post(self, **kw):
        self.signed = kw
        return {'url': 'https://synthetic.invalid', 'fields': {'key': kw['Key']}}
    def head_object(self, **kw):
        return {'ContentLength': len(self.data), 'ContentType': self.mime, 'ETag': 'synthetic-etag'}
    def get_object(self, **kw):
        assert kw.get('IfMatch') == 'synthetic-etag'
        return {'Body': BytesIO(self.data)}
    def put_object(self, **kw):
        self.puts.append(kw)


def image_bytes():
    stream = BytesIO()
    Image.new('RGB', (4, 4), 'white').save(stream, format='PNG')
    return stream.getvalue()


def start_upload(client, mid, data):
    result = client.post(f'/memories/{mid}/image/uploads', json={
        'filename': 'synthetic.png', 'content_type': 'image/png', 'size': len(data)}, headers=headers())
    assert result.status_code == 201
    return result.json()['upload_id']


def test_pending_upload_owner_validation_and_immutable_promotion(cloud_api, monkeypatch):
    data = image_bytes()
    s3 = FakeS3(data)
    monkeypatch.setattr(storage, 's3_client', lambda: s3)
    mid = memory(cloud_api)
    uid = start_upload(cloud_api, mid, data)
    assert s3.signed['Conditions'][-1] == ['content-length-range', len(data), len(data)]
    base = f'/memories/{mid}/image'
    assert cloud_api.post(base+'/ocr', headers=headers()).status_code == 400
    assert cloud_api.post(base+'/uploads/complete', json={'upload_id': uid}, headers=headers('bob')).status_code == 404
    s3.mime = 'image/jpeg'
    assert cloud_api.post(base+'/uploads/complete', json={'upload_id': uid}, headers=headers()).status_code == 422
    assert not s3.puts
    s3.mime = 'image/png'
    result = cloud_api.post(base+'/uploads/complete', json={'upload_id': uid}, headers=headers())
    assert result.status_code == 200
    assert result.json()['source_image_path'].startswith('s3://synthetic-test-bucket/users/alice/originals/')
    assert s3.puts[0]['Body'] == data
    assert s3.puts[0]['Key'] != s3.signed['Key']
    assert cloud_api.post(base+'/uploads/complete', json={'upload_id': uid}, headers=headers()).status_code == 200
    assert len(s3.puts) == 1


@pytest.mark.parametrize('mode', ['size', 'invalid', 'expired'])
def test_reject_invalid_or_expired_uploads(cloud_api, monkeypatch, mode):
    data = image_bytes()
    fake = FakeS3(data)
    monkeypatch.setattr(storage, 's3_client', lambda: fake)
    mid = memory(cloud_api)
    uid = start_upload(cloud_api, mid, data)
    if mode == 'size': fake.data += b'bad'
    if mode == 'invalid': fake.data = b'x' * len(data)
    if mode == 'expired':
        with SessionLocal() as db:
            db.get(ImageUpload, uid).expires_at = datetime.now(UTC) - timedelta(seconds=1)
            db.commit()
    result = cloud_api.post(f'/memories/{mid}/image/uploads/complete', json={'upload_id': uid}, headers=headers())
    assert result.status_code == (410 if mode == 'expired' else 422)
    assert not fake.puts


def test_s3_temporary_file_cleanup_on_failure(cloud_api, monkeypatch):
    data = image_bytes()
    mid = memory(cloud_api)
    with SessionLocal() as db:
        db.get(Memory, mid).source_image_path = f's3://synthetic-test-bucket/users/alice/originals/{mid}-test.png'
        db.commit()
    paths = []
    monkeypatch.setattr(storage, 's3_client', lambda: SimpleNamespace(get_object=lambda **kw: {'Body': BytesIO(data)}))
    def fail(path):
        paths.append(path)
        assert path.exists() and path.parent == Path('/tmp')
        raise vision.VisionError('timeout')
    monkeypatch.setattr(vision, 'recognize_image', fail)
    result = cloud_api.post(f'/memories/{mid}/image/recognize', json={'consent': True, 'request_id': 'fail'}, headers=headers())
    assert result.json()['metadata']['error'] == 'timeout'
    assert paths and not paths[0].exists()


def test_provider_runs_without_checked_out_database_transaction(monkeypatch):
    from app.routes import images
    client = TestClient(app)
    mid = client.post('/memories/from-image', files={'image': ('test.png', b'synthetic', 'image/png')}).json()['id']
    def provider(path):
        assert engine.pool.checkedout() == 0
        # No caller transaction or row lock may remain while this provider runs.
        with engine.connect() as connection:
            row = connection.execute(select(Memory.operation_token).where(Memory.id == mid)).first()
            assert row.operation_token
        # Concurrent edit must prevent stale AI results being persisted.
        with SessionLocal() as db:
            db.get(Memory, mid).title = 'Concurrent synthetic edit'
            db.commit()
        return {'draft': {'text': 'draft', 'warnings': []}, 'model': 'mock', 'usage': {}, 'duration_ms': 1}
    monkeypatch.setattr(vision, 'recognize_image', provider)
    result = client.post(f'/memories/{mid}/image/recognize', json={'consent': True, 'request_id': 'concurrent'})
    assert result.status_code == 409
    with SessionLocal() as db:
        value = db.get(Memory, mid)
        assert value.title == 'Concurrent synthetic edit' and value.image_text_draft is None
        assert value.operation_token is None


def test_deadline_shared_across_paid_calls(monkeypatch):
    from app.deadline import expires, remaining
    import app.deadline as deadline
    monkeypatch.setattr(deadline, 'monotonic', lambda: 10)
    token = expires.set(15)
    try:
        assert remaining() == 4.5
        monkeypatch.setattr(deadline, 'monotonic', lambda: 16)
        mock = Mock()
        monkeypatch.setattr(vision.urllib.request, 'build_opener', lambda *args: SimpleNamespace(open=mock))
        monkeypatch.setenv('OPENAI_API_KEY', 'synthetic-only')
        with pytest.raises(vision.VisionError) as error:
            vision._request({}, vision.ImageTextDraft)
        assert error.value.code == 'timeout'
        mock.assert_not_called()
    finally:
        expires.reset(token)


def test_migrations_reject_pooler_before_connect():
    from migrations.__main__ import migrate
    with pytest.raises(ValueError, match='direct'):
        migrate('postgresql+psycopg://user:synthetic@ep-test-pooler.ap-southeast-2.aws.neon.tech/test')


def test_postgresql_versioned_migrations_preserve_synthetic_data():
    if engine.dialect.name != 'postgresql':
        pytest.skip('Isolated PostgreSQL unavailable; migration DDL not validated by SQLite')
    from migrations.__main__ import migrate
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import make_url
    from uuid import uuid4
    from app.database import DATABASE_URL
    schema = 'migration_test_' + uuid4().hex
    with engine.begin() as connection:
        connection.exec_driver_sql(f'CREATE SCHEMA {schema}')
    target = make_url(DATABASE_URL).update_query_dict({'options': f'-csearch_path={schema},public'})
    temporary = create_engine(target)
    try:
        # An unversioned legacy table with TEXT embeddings and synthetic content.
        with temporary.begin() as connection:
            connection.exec_driver_sql("""CREATE TABLE memories (
                id SERIAL PRIMARY KEY, user_id VARCHAR(100), title VARCHAR(200),
                original_text TEXT, confirmed_content TEXT, category VARCHAR(100),
                tags TEXT, embedding TEXT)""")
            connection.execute(text("""INSERT INTO memories
                (user_id,title,original_text,confirmed_content,category,tags)
                VALUES ('legacy-owner','synthetic','original','reviewed','Event Announcement','[]')"""))
        migrate(target.render_as_string(hide_password=False))
        migrate(target.render_as_string(hide_password=False))
        with temporary.connect() as connection:
            row = connection.execute(text('SELECT original_text, confirmed_content, user_id, category FROM memories')).one()
            assert tuple(row) == ('original', 'reviewed', 'legacy-owner', 'event')
            assert connection.scalar(text('SELECT count(*) FROM schema_versions')) == 2
            assert connection.scalar(text("""SELECT format_type(atttypid, atttypmod) FROM pg_attribute
                WHERE attrelid='memories'::regclass AND attname='embedding'""")) == 'vector(1536)'
    finally:
        temporary.dispose()
        with engine.begin() as connection:
            connection.exec_driver_sql(f'DROP SCHEMA {schema} CASCADE')


def test_real_rsa_jwt_verification(monkeypatch):
    jwt = pytest.importorskip('jwt', reason='PyJWT/cryptography install blocked by network')
    crypto = pytest.importorskip('cryptography.hazmat.primitives.asymmetric.rsa')
    key = crypto.generate_private_key(public_exponent=65537, key_size=2048)
    monkeypatch.setattr(config, 'COGNITO_ISSUER', 'https://cognito-idp.ap-southeast-2.amazonaws.com/test_pool')
    monkeypatch.setattr(config, 'COGNITO_CLIENT_ID', 'synthetic-client')
    monkeypatch.setattr(auth, 'jwks_client', lambda: SimpleNamespace(get_signing_key_from_jwt=lambda _: SimpleNamespace(key=key.public_key())))
    now = int(datetime.now(UTC).timestamp())
    claims = {'iss': config.COGNITO_ISSUER, 'client_id': config.COGNITO_CLIENT_ID, 'token_use': 'access',
              'sub': 'alice', 'iat': now, 'exp': now + 60}
    def token(values):
        return 'Bearer ' + jwt.encode(values, key, algorithm='RS256', headers={'kid': 'synthetic'})
    assert auth.verify_access_token(token(claims)) == 'alice'
    from fastapi import HTTPException
    for values in [{**claims, 'token_use': 'id'}, {**claims, 'client_id': 'other'},
                   {**claims, 'iss': 'https://invalid.example'}, {**claims, 'exp': now-60}]:
        with pytest.raises(HTTPException): auth.verify_access_token(token(values))


def test_import_does_not_connect_or_initialize_schema(tmp_path):
    import os
    import subprocess
    import sys
    target = tmp_path / 'must-not-be-created.sqlite'
    environment = {**os.environ, 'DATABASE_URL': f'sqlite:///{target}', 'APP_ENV': 'local',
                   'AUTH_MODE': 'local', 'STORAGE_BACKEND': 'local', 'OPENAI_API_KEY': ''}
    result = subprocess.run([sys.executable, '-c', 'import app.main'], env=environment, capture_output=True)
    assert result.returncode == 0
    assert not target.exists()


def test_cloud_configuration_fails_closed(tmp_path):
    import os
    import subprocess
    import sys
    environment = {**os.environ, 'APP_ENV': 'cloud', 'AUTH_MODE': 'local', 'STORAGE_BACKEND': 'local'}
    result = subprocess.run([sys.executable, '-c', 'import app.config'], env=environment, capture_output=True)
    assert result.returncode != 0
    assert b'Cloud requires Cognito and S3' in result.stderr


def test_cognito_owner_applies_to_query_and_clarification(cloud_api, monkeypatch):
    from app.query_plan import QueryPlan
    from app.services import query_conversation
    alice = memory(cloud_api, 'alice')
    bob = memory(cloud_api, 'bob')
    contexts = []
    def provider(payload, model):
        if model is QueryPlan:
            return {'draft': {'version': '1', 'operations': [{'operation': 'limit', 'count': 100}], 'clarification_questions': []}}
        data = json.loads(payload['input'][0]['content'][0]['text'])
        contexts.append(data['memories'])
        ids = [m['memory_id'] for m in data['memories']]
        assert alice not in ids and bob in ids
        return {'draft': {'answer': f'Synthetic answer [Memory {bob}]', 'memory_ids': [bob]}}
    monkeypatch.setattr(vision, '_request', provider)
    result = cloud_api.post('/memories/query', json={'question': 'Show records', 'consent': True,
        'today': '2026-10-30'}, headers=headers('bob'))
    assert result.status_code == 200 and result.json()['status'] == 'completed'
    assert contexts
    from uuid import uuid4
    cid = str(uuid4())
    query_conversation.save_pending('alice', cid, {'question': 'Synthetic private question'},
        QueryPlan.model_validate({'version': '1', 'operations': [], 'clarification_questions': ['Where?']}))
    theft = cloud_api.post('/memories/query', json={'question': 'Hamilton', 'consent': True,
        'today': '2026-10-30', 'conversation_id': cid, 'is_clarification_reply': True}, headers=headers('bob'))
    assert theft.json()['status'] == 'needs_clarification'
    assert query_conversation.take_pending('alice', cid) is not None
