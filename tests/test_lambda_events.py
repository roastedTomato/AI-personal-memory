import os

import pytest

if not os.getenv("DATABASE_URL"):
    pytest.skip("DATABASE_URL is required for Lambda integration tests", allow_module_level=True)

from app.adapters.lambda_handler import handler


def test_http_api_v2_health_event():
    event = {
        "version": "2.0",
        "routeKey": "GET /health",
        "rawPath": "/health",
        "requestContext": {
            "http": {
                "method": "GET",
                "path": "/health",
                "sourceIp": "127.0.0.1",
                "userAgent": "m1.4-test",
            },
            "stage": "$default",
        },
        "headers": {},
        "isBase64Encoded": False,
    }
    response = handler(event, {})
    assert response["statusCode"] == 200
    assert '"status":"ok"' in response["body"]


def test_http_api_v2_protected_event_without_auth():
    event = {
        "version": "2.0",
        "routeKey": "GET /protected-test",
        "rawPath": "/protected-test",
        "requestContext": {
            "http": {
                "method": "GET",
                "path": "/protected-test",
                "sourceIp": "127.0.0.1",
                "userAgent": "m1.4-test",
            },
            "stage": "$default",
        },
        "headers": {},
        "isBase64Encoded": False,
    }
    response = handler(event, {})
    assert response["statusCode"] == 401


def test_http_api_v2_protected_event_with_auth():
    event = {
        "version": "2.0",
        "routeKey": "GET /protected-test",
        "rawPath": "/protected-test",
        "requestContext": {
            "http": {
                "method": "GET",
                "path": "/protected-test",
                "sourceIp": "127.0.0.1",
                "userAgent": "m1.4-test",
            },
            "stage": "$default",
        },
        "headers": {"authorization": "Bearer m1-4-synthetic-token"},
        "isBase64Encoded": False,
    }
    response = handler(event, {})
    assert response["statusCode"] == 200

