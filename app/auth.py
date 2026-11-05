import os


def is_valid_synthetic_token(token: str | None) -> bool:
    expected = os.getenv("POC_AUTH_TOKEN", "m1-4-synthetic-token")
    return bool(token) and token == expected


from contextvars import ContextVar
from functools import lru_cache
from fastapi import HTTPException
from . import config

_owner = ContextVar('authenticated_owner', default=None)


def current_user() -> str:
    owner = _owner.get()
    if owner:
        return owner
    if config.AUTH_MODE == 'local' and config.APP_ENV != 'cloud':
        return config.LOCAL_USER_ID
    raise HTTPException(401, detail='Authentication required')


@lru_cache(maxsize=1)
def jwks_client():
    from jwt import PyJWKClient
    return PyJWKClient(config.COGNITO_ISSUER + '/.well-known/jwks.json',
                       lifespan=300, timeout=3)


def verify_access_token(authorization: str | None) -> str:
    import jwt
    if not authorization or not authorization.startswith('Bearer '):
        raise HTTPException(401, detail='Authentication required')
    token = authorization[7:].strip()
    if not token or len(token) > 16384:
        raise HTTPException(401, detail='Invalid access token')
    try:
        key = jwks_client().get_signing_key_from_jwt(token)
        claims = jwt.decode(token, key.key, algorithms=['RS256'], issuer=config.COGNITO_ISSUER,
                            options={'verify_aud': False, 'require': ['exp', 'iat', 'iss', 'sub', 'token_use', 'client_id']})
        if (claims['token_use'] != 'access' or claims['client_id'] != config.COGNITO_CLIENT_ID
                or not isinstance(claims['sub'], str) or not 0 < len(claims['sub']) <= 100):
            raise ValueError
        return claims['sub']
    except (jwt.InvalidTokenError, jwt.PyJWKClientError, ValueError, KeyError, TypeError):
        raise HTTPException(401, detail='Invalid or expired access token') from None


def verify_identity_token(token: str) -> tuple[str, str]:
    """Return (subject, verified email) from a Cognito ID token."""
    import jwt
    if not token or len(token) > 16384:
        raise HTTPException(401, detail='Invalid identity token')
    try:
        key = jwks_client().get_signing_key_from_jwt(token)
        claims = jwt.decode(token, key.key, algorithms=['RS256'], issuer=config.COGNITO_ISSUER,
                            audience=config.COGNITO_CLIENT_ID,
                            options={'require': ['exp', 'iat', 'iss', 'sub', 'aud', 'token_use']})
        email = claims.get('email')
        if (claims.get('token_use') != 'id' or not isinstance(claims.get('sub'), str)
                or not 0 < len(claims['sub']) <= 100 or claims.get('email_verified') is not True
                or not isinstance(email, str) or len(email) > 320 or '@' not in email):
            raise ValueError
        return claims['sub'], email
    except (jwt.InvalidTokenError, jwt.PyJWKClientError, ValueError, KeyError, TypeError):
        raise HTTPException(401, detail='A verified Cognito email is required') from None
