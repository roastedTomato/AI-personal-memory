"""Private immutable S3 originals, local uploads, and request-scoped scratch files."""
from contextvars import ContextVar
from pathlib import Path
from tempfile import NamedTemporaryFile
from functools import lru_cache
from fastapi import HTTPException
from . import config
from .auth import current_user

MAX_IMAGE_SIZE = 10 * 1024 * 1024
ALLOWED_TYPES = {'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/webp': 'WEBP'}
scratch = ContextVar('scratch_images', default=None)


@lru_cache(maxsize=1)
def s3_client():
    import boto3
    from botocore.config import Config
    return boto3.client('s3', config=Config(signature_version='s3v4', connect_timeout=3,
                                           read_timeout=5, retries={'total_max_attempts': 1}))


def object_key(path):
    prefix = f's3://{config.S3_BUCKET}/users/{current_user()}/'
    if not path.startswith(prefix) or '/originals/' not in path or '..' in path:
        raise HTTPException(400, detail='Managed image unavailable')
    return path[len(f's3://{config.S3_BUCKET}/'):]


def presigned_read(path):
    return s3_client().generate_presigned_url('get_object', Params={'Bucket': config.S3_BUCKET,
               'Key': object_key(path)}, ExpiresIn=300)


def materialize(path):
    key = object_key(path)
    files = scratch.get()
    if files is None:
        raise RuntimeError('S3 materialization requires request cleanup context')
    response = s3_client().get_object(Bucket=config.S3_BUCKET, Key=key)
    body = response['Body']
    try:
        data = body.read(MAX_IMAGE_SIZE + 1)
    finally:
        body.close()
    if not 0 < len(data) <= MAX_IMAGE_SIZE:
        raise HTTPException(413, detail='Image exceeds 10 MB limit')
    with NamedTemporaryFile(prefix='memory-', suffix=Path(key).suffix, dir='/tmp', delete=False) as file:
        files.append(Path(file.name))
        file.write(data)
    return Path(file.name)


def delete_original(path):
    s3_client().delete_object(Bucket=config.S3_BUCKET, Key=object_key(path))
