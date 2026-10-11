from __future__ import annotations

import json
import socket
import time

from helpers import json_answer, make_client, make_config

from starter_crm.errors import from_upstream, upstream_code

CANARY = "RAW-UPSTREAM-CANARY"
RETRY_HEADERS = {"Retry-After": "7"}


def test_upstream_code_prefers_detail_code_then_details_code_code_error_then_the_type_slug():
    assert upstream_code(403, {"message": "m", "detail": {"code": "consent_required"}}) == "consent_required"
    assert upstream_code(403, {"details": {"code": "byoc_required"}}) == "byoc_required"
    assert upstream_code(400, {"code": "invalid_site_id"}) == "invalid_site_id"
    assert upstream_code(400, {"error": "invalid_request"}) == "invalid_request"
    payment = {"type": "https://api-v2.dropcowboy.com/errors/payment-required", "detail": "Add funds."}
    assert upstream_code(402, payment) == "payment-required"
    scope = {"type": "https://api-v2.dropcowboy.com/errors/insufficient-scope"}
    assert upstream_code(403, scope) == "insufficient-scope"


def test_upstream_code_falls_back_to_a_code_for_the_status():
    assert upstream_code(402, None) == "payment-required"
    assert upstream_code(403, {}) == "forbidden"
    assert upstream_code(429, "text") == "too-many-requests"
    assert upstream_code(418, {}) == "bad-request"


def test_from_upstream_keeps_the_status_and_code_of_a_4xx_and_a_short_message():
    body = {"message": "A valid consent_id is required", "detail": {"code": "consent_required"}, "debug": CANARY}
    err = from_upstream(403, body, RETRY_HEADERS)
    assert (err.status, err.code, err.message) == (403, "consent_required", "A valid consent_id is required")
    assert CANARY not in json.dumps(vars(err))


def test_from_upstream_turns_a_401_into_502_upstream_auth_failed():
    err = from_upstream(401, {"type": "https://api-v2.dropcowboy.com/errors/unauthorized"}, RETRY_HEADERS)
    assert (err.status, err.code) == (502, "upstream_auth_failed")


def test_from_upstream_never_passes_a_5xx_message_through():
    err = from_upstream(500, {"detail": CANARY}, RETRY_HEADERS)
    assert (err.status, err.code) == (502, "upstream_error")
    assert CANARY not in err.message


def test_from_upstream_copies_retry_after_on_429_only():
    assert from_upstream(429, {}, RETRY_HEADERS).headers == {"Retry-After": "7"}
    assert from_upstream(403, {}, RETRY_HEADERS).headers == {}


def test_from_upstream_caps_long_messages_at_300_characters():
    assert len(from_upstream(400, {"detail": "x" * 1000}, RETRY_HEADERS).message) == 300


def mint(config):
    return make_client(config).post("/api/dropcowboy/token", json={"purpose": "session"})


def test_passes_402_payment_required_through(upstream):
    upstream.respond = lambda call: json_answer(
        402,
        {
            "type": "https://api-v2.dropcowboy.com/errors/payment-required",
            "title": "Payment Required",
            "status": 402,
            "detail": "Add funds to continue.",
            "instance": CANARY,
        },
    )
    response = mint(make_config(DROPCOWBOY_API_BASE=upstream.url))
    assert response.status_code == 402
    assert response.get_json() == {"error": {"code": "payment-required", "message": "Add funds to continue."}}


def test_maps_a_timeout_to_504_upstream_timeout(upstream):
    def slow(call):
        time.sleep(0.5)
        return json_answer(200, {"data": {}})

    upstream.respond = slow
    response = mint(make_config(DROPCOWBOY_API_BASE=upstream.url, DROPCOWBOY_TIMEOUT_MS="50"))
    assert response.status_code == 504
    assert response.get_json()["error"]["code"] == "upstream_timeout"


def test_maps_a_connection_failure_to_502_upstream_unreachable():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        closed_port = probe.getsockname()[1]
    response = mint(make_config(DROPCOWBOY_API_BASE="http://127.0.0.1:" + str(closed_port)))
    assert response.status_code == 502
    assert response.get_json()["error"]["code"] == "upstream_unreachable"


def test_maps_a_non_json_upstream_error_to_502_upstream_error(upstream):
    upstream.respond = lambda call: (502, "<html>" + CANARY + "</html>", {"Content-Type": "text/html"})
    response = mint(make_config(DROPCOWBOY_API_BASE=upstream.url))
    assert response.status_code == 502
    assert response.get_json()["error"]["code"] == "upstream_error"
    assert CANARY not in response.get_data(as_text=True)


def test_never_follows_a_redirect_so_the_api_key_stays_put(upstream):
    upstream.respond = lambda call: (302, "", {"Location": upstream.url + "/somewhere-else"})
    response = mint(make_config(DROPCOWBOY_API_BASE=upstream.url))
    assert response.status_code == 502
    assert response.get_json()["error"]["code"] == "upstream_unreachable"
    assert [call["path"] for call in upstream.calls] == ["/phone/public/embed/token"]


def test_wraps_unknown_routes_in_the_envelope():
    response = make_client(make_config()).get("/api/nothing-here?x=1")
    assert response.status_code == 404
    assert response.get_json() == {"error": {"code": "not_found", "message": "No route matches GET /api/nothing-here."}}


def test_a_known_path_with_the_wrong_method_is_404_not_found():
    response = make_client(make_config()).post("/healthz")
    assert response.status_code == 404
    assert response.get_json()["error"]["code"] == "not_found"


def test_bodies_over_1_mb_are_413_payload_too_large():
    response = make_client(make_config()).post(
        "/webhooks/dropcowboy", data=b"x" * (1024 * 1024 + 1), headers={"X-Signature": "s", "X-Timestamp": "1"}
    )
    assert response.status_code == 413
    assert response.get_json()["error"]["code"] == "payload_too_large"
