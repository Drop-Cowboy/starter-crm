from __future__ import annotations

import pytest
from helpers import API_KEY, API_SECRET, SITE_ID, USER_ID, json_answer, make_client, make_config

from starter_crm.token import PURPOSE_SCOPES, scopes_for_purpose

TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl"
ACCESS_TOKEN = "unit-test-access-token-0004"


def success(call):
    return json_answer(
        200,
        {
            "data": {
                "token": TOKEN,
                "expires_at": 1790000000000,
                "jti": "0b6f2a1c-3d4e-4f5a-8b6c-7d8e9f0a1b2c",
                "pool_id": "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b",
            }
        },
    )


def test_scopes_for_purpose_maps_each_purpose_to_its_fixed_scopes():
    assert scopes_for_purpose("session") == ["dialer:webrtc", "contacts"]
    assert scopes_for_purpose("contacts") == ["contacts"]
    assert scopes_for_purpose("campaigns") == ["campaigns"]
    assert scopes_for_purpose("phone") == ["phone:hub"]


def test_the_contacts_purpose_has_no_calling_scope_so_it_never_hits_the_carrier_or_balance_check():
    assert "dialer:webrtc" not in scopes_for_purpose("contacts")
    assert "phone:hub" not in scopes_for_purpose("contacts")


def test_scopes_for_purpose_rejects_unknown_purposes_prototype_keys_and_non_strings():
    for purpose in [
        "admin",
        "",
        "constructor",
        "__proto__",
        "toString",
        "__class__",
        None,
        42,
        ["session"],
        {"purpose": "session"},
    ]:
        assert scopes_for_purpose(purpose) is None


def test_scopes_for_purpose_returns_a_copy_the_caller_cannot_use_to_change_the_allowlist():
    scopes = scopes_for_purpose("phone")
    scopes.append("numbers:write")
    assert PURPOSE_SCOPES["phone"] == ("phone:hub",)
    with pytest.raises(TypeError):
        PURPOSE_SCOPES["admin"] = ("numbers:write",)


def post(upstream, body):
    client = make_client(make_config(DROPCOWBOY_API_BASE=upstream.url))
    if isinstance(body, str):
        return client.post("/api/dropcowboy/token", data=body, content_type="application/json")
    return client.post("/api/dropcowboy/token", json=body)


def test_mints_with_the_api_key_and_returns_only_token_and_expires_at(upstream):
    upstream.respond = success
    response = post(upstream, {"purpose": "session"})

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.get_json() == {"token": TOKEN, "expires_at": 1790000000000}

    call = upstream.calls[0]
    assert (call["method"], call["path"]) == ("POST", "/phone/public/embed/token")
    assert call["headers"]["x-key"] == API_KEY
    assert call["headers"]["x-secret"] == API_SECRET
    scope = ["dialer:webrtc", "contacts"]
    assert call["body"] == {"site_id": SITE_ID, "sub": USER_ID, "scope": scope, "ttl_seconds": 900}


def test_ignores_scope_sub_site_id_and_ttl_sent_by_the_browser(upstream):
    upstream.respond = success
    post(
        upstream,
        {
            "purpose": "campaigns",
            "scope": ["numbers:write"],
            "sub": "someone-else",
            "site_id": "00000000-0000-4000-8000-000000000000",
            "ttl_seconds": 86400,
        },
    )
    assert upstream.calls[0]["body"] == {"site_id": SITE_ID, "sub": USER_ID, "scope": ["campaigns"], "ttl_seconds": 900}


@pytest.mark.parametrize("body", [{"purpose": "admin"}, {"purpose": "constructor"}, {}, [], ""])
def test_answers_400_invalid_purpose_without_calling_upstream(upstream, body):
    response = post(upstream, body)
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "invalid_purpose"
    assert upstream.calls == []


def test_names_every_purpose_in_the_invalid_purpose_message(upstream):
    response = post(upstream, {"purpose": "admin"})
    assert response.get_json()["error"]["message"] == "purpose must be one of: session, contacts, campaigns, phone"


def test_mints_the_contacts_purpose_with_only_the_contacts_scope(upstream):
    upstream.respond = success
    response = post(upstream, {"purpose": "contacts"})
    assert response.status_code == 200
    assert upstream.calls[0]["body"] == {"site_id": SITE_ID, "sub": USER_ID, "scope": ["contacts"], "ttl_seconds": 900}


@pytest.mark.parametrize("body", ['{"purpose":', '"session"', "NaN"])
def test_answers_400_invalid_json_for_a_malformed_body(upstream, body):
    response = post(upstream, body)
    assert response.status_code == 400
    assert response.get_json() == {"error": {"code": "invalid_json", "message": "Request body is not valid JSON."}}
    assert upstream.calls == []


def test_answers_502_when_upstream_success_lacks_a_token(upstream):
    upstream.respond = lambda call: json_answer(200, {"data": {}})
    response = post(upstream, {"purpose": "session"})
    assert response.status_code == 502
    assert response.get_json()["error"]["code"] == "upstream_error"


def test_sends_the_api_key_never_a_bearer_the_browser_sent(upstream):
    upstream.respond = success
    client = make_client(make_config(DROPCOWBOY_API_BASE=upstream.url))
    browser_bearer = {"Authorization": "Bearer " + ACCESS_TOKEN}
    client.post("/api/dropcowboy/token", json={"purpose": "session"}, headers=browser_bearer)
    assert upstream.calls[0]["headers"]["x-key"] == API_KEY
    assert "authorization" not in upstream.calls[0]["headers"]


def test_answers_502_upstream_auth_failed_when_drop_cowboy_refuses_the_api_key(upstream):
    upstream.respond = lambda call: json_answer(401, {"title": "Unauthorized"})
    response = post(upstream, {"purpose": "session"})
    assert response.status_code == 502
    assert response.get_json()["error"]["code"] == "upstream_auth_failed"


def test_is_not_registered_in_mcp_session_mode():
    response = make_client(make_config(DC_AUTH_MODE="mcp-session")).post("/api/dropcowboy/token")
    assert response.status_code == 404
    assert response.get_json()["error"]["code"] == "not_found"


def login_post(upstream, body, authorization="Bearer " + ACCESS_TOKEN):
    client = make_client(make_config(DC_AUTH_MODE="login", DROPCOWBOY_API_BASE=upstream.url))
    headers = {} if authorization is None else {"Authorization": authorization}
    return client.post("/api/dropcowboy/token", json=body, headers=headers)


def test_login_forwards_the_access_token_instead_of_the_api_key_with_no_sub(upstream):
    upstream.respond = success
    response = login_post(
        upstream, {"purpose": "phone", "sub": "someone-else", "scope": ["numbers:write"], "ttl_seconds": 86400}
    )

    assert response.status_code == 200
    assert response.get_json() == {"token": TOKEN, "expires_at": 1790000000000}
    call = upstream.calls[0]
    assert call["headers"]["authorization"] == "Bearer " + ACCESS_TOKEN
    assert "x-key" not in call["headers"]
    assert "x-secret" not in call["headers"]
    assert call["body"] == {"site_id": SITE_ID, "scope": ["phone:hub"], "ttl_seconds": 900}


def test_login_accepts_the_scheme_in_any_case_and_forwards_it_as_bearer(upstream):
    upstream.respond = success
    login_post(upstream, {"purpose": "session"}, authorization="bearer " + ACCESS_TOKEN)
    assert upstream.calls[0]["headers"]["authorization"] == "Bearer " + ACCESS_TOKEN


@pytest.mark.parametrize("authorization", [None, "Basic dXNlcjpwYXNz", "Bearer ", "Bearer one two"])
def test_login_answers_401_login_required_without_calling_upstream(upstream, authorization):
    response = login_post(upstream, {"purpose": "session"}, authorization=authorization)
    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "login_required"
    assert upstream.calls == []


def test_login_answers_401_login_expired_without_echoing_the_token(upstream):
    upstream.respond = lambda call: json_answer(401, {"title": "Unauthorized"})
    response = login_post(upstream, {"purpose": "session"})
    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "login_expired"
    assert ACCESS_TOKEN not in response.get_data(as_text=True)
