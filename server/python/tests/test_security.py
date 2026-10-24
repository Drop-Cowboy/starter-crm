"""Response headers, CORS, request ids and the rate limits, through the whole app."""

from __future__ import annotations

from helpers import make_booted_client

ORIGIN = "https://crm.example.com"


def client(tmp_path, **env):
    (tmp_path / ".dropcowboy").mkdir(exist_ok=True)
    (tmp_path / ".dropcowboy" / "session.json").write_text('{"token": "dev-token", "expires_at": 9999999999999}')
    return make_booted_client(tmp_path, **env)[0]


def test_every_response_carries_the_security_headers_and_a_request_id(tmp_path):
    response = client(tmp_path).get("/healthz")
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["Cross-Origin-Opener-Policy"] == "same-origin"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Permissions-Policy"] == "microphone=(self), camera=(), geolocation=()"
    assert "Content-Security-Policy-Report-Only" in response.headers
    assert "Strict-Transport-Security" not in response.headers
    assert response.headers["X-Request-Id"]


def test_hsts_is_sent_only_in_production(tmp_path):
    response = client(tmp_path, DC_ENV="production", DC_IDENTITY="passcode", DC_PASSCODE="a-long-enough-passcode").get(
        "/healthz"
    )
    assert response.headers["Strict-Transport-Security"] == "max-age=31536000"


def test_csp_can_be_enforced_or_turned_off(tmp_path):
    enforced = client(tmp_path, DC_CSP="enforce").get("/healthz")
    assert "Content-Security-Policy" in enforced.headers
    off = client(tmp_path, DC_CSP="off").get("/healthz")
    assert "Content-Security-Policy" not in off.headers
    assert "Content-Security-Policy-Report-Only" not in off.headers


def test_a_good_request_id_is_kept_and_a_bad_one_is_replaced(tmp_path):
    app = client(tmp_path)
    assert app.get("/healthz", headers={"X-Request-Id": "trace-123.abc"}).headers["X-Request-Id"] == "trace-123.abc"
    replaced = app.get("/healthz", headers={"X-Request-Id": "has spaces!"}).headers["X-Request-Id"]
    assert replaced != "has spaces!"
    assert len(replaced) == 36


def test_the_request_id_is_in_the_error_envelope(tmp_path):
    response = client(tmp_path).get("/api/nope", headers={"X-Request-Id": "abc-1"})
    assert response.get_json()["error"]["request_id"] == "abc-1"


def test_cors_is_off_by_default(tmp_path):
    response = client(tmp_path).open("/api/config", method="OPTIONS", headers={"Origin": ORIGIN})
    assert response.status_code == 404
    assert "Access-Control-Allow-Origin" not in response.headers


def test_cors_echoes_an_allowed_origin_and_rejects_another_preflight(tmp_path):
    app = client(tmp_path, DC_CORS_ORIGINS=ORIGIN)
    simple = app.get("/api/config", headers={"Origin": ORIGIN})
    assert simple.headers["Access-Control-Allow-Origin"] == ORIGIN
    assert simple.headers["Vary"] == "Origin"
    assert simple.headers["Access-Control-Expose-Headers"] == "X-Request-Id, Retry-After"
    allowed = app.open(
        "/api/dropcowboy/token",
        method="OPTIONS",
        headers={"Origin": ORIGIN, "Access-Control-Request-Method": "POST"},
    )
    assert allowed.status_code == 204
    refused = app.open(
        "/api/dropcowboy/token",
        method="OPTIONS",
        headers={"Origin": "https://evil.example.org", "Access-Control-Request-Method": "POST"},
    )
    assert refused.status_code == 403
    assert refused.get_json()["error"]["code"] == "cors_rejected"
    assert app.open("/api/config", method="OPTIONS", headers={"Origin": ORIGIN}).status_code == 404


def test_the_dev_session_route_is_limited_per_client_ip(tmp_path):
    app = client(tmp_path, DC_AUTH_MODE="mcp-session")
    statuses = [
        app.get(
            "/__dev/session", base_url="http://localhost:8080", headers={"X-Forwarded-For": "192.0.2.11"}
        ).status_code
        for _ in range(11)
    ]
    assert statuses[:10] == [200] * 10
    assert statuses[10] == 429


def test_a_limited_response_has_an_integer_retry_after_and_the_envelope(tmp_path):
    app = client(tmp_path, DC_AUTH_MODE="mcp-session")
    for _ in range(10):
        app.get("/__dev/session", base_url="http://localhost:8080")
    limited = app.get("/__dev/session", base_url="http://localhost:8080")
    assert limited.status_code == 429
    assert limited.get_json()["error"]["code"] == "rate_limited"
    assert int(limited.headers["Retry-After"]) >= 1


def test_rate_limiting_can_be_turned_off(tmp_path):
    app = client(tmp_path, DC_AUTH_MODE="mcp-session", DC_RATE_LIMIT="off")
    assert {app.get("/__dev/session", base_url="http://localhost:8080").status_code for _ in range(15)} == {200}


def test_the_client_ip_is_the_peer_unless_a_proxy_is_trusted(tmp_path):
    app = client(tmp_path, DC_AUTH_MODE="mcp-session")
    for _ in range(10):
        app.get("/__dev/session", base_url="http://localhost:8080", headers={"X-Forwarded-For": "192.0.2.22"})
    # Not trusting the proxy, so a different X-Forwarded-For is still the same client.
    assert (
        app.get(
            "/__dev/session", base_url="http://localhost:8080", headers={"X-Forwarded-For": "192.0.2.33"}
        ).status_code
        == 429
    )
    trusting = client(tmp_path, DC_AUTH_MODE="mcp-session", DC_TRUST_PROXY="1")
    for _ in range(10):
        trusting.get("/__dev/session", base_url="http://localhost:8080", headers={"X-Forwarded-For": "192.0.2.22"})
    assert (
        trusting.get(
            "/__dev/session", base_url="http://localhost:8080", headers={"X-Forwarded-For": "192.0.2.33"}
        ).status_code
        == 200
    )
