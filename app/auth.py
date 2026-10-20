import os


def is_valid_synthetic_token(token: str | None) -> bool:
    expected = os.getenv("POC_AUTH_TOKEN", "m1-4-synthetic-token")
    return bool(token) and token == expected

