"""The passcode identity: sign in, the cookie, sign out, CSRF, and the sign-in limit."""

from __future__ import annotations

import base64
import json
import uuid

from helpers import SITE_ID, make_booted_client

PASSCODE = "a-long-enough-passcode"
ORIGIN = "http://localhost"


def passcode_client(tmp_path, **env):
    values = {"DC_IDENTITY": "passcode", "DC_PASSCODE": PASSCODE, "STARTER_CRM_USER_ID": ""}
    values.update(env)
    return make_booted_client(tmp_path, **values)[0]


def sign_in(app, passcode=PASSCODE, **headers):
    sent = {"Origin": ORIGIN}
    sent.update(headers)
    return app.post("/api/auth/passcode", json={"passcode": passcode}, headers=sent)


def cookie_of(response):
    return response.headers["Set-Cookie"].split(";")[0]


def test_a_correct_passcode_sets_a_http_only_session_cookie(tmp_path):
    response = sign_in(passcode_client(tmp_path))
    assert response.status_code == 200
    assert response.get_json() == {"signed_in": True}
    attributes = response.headers["Set-Cookie"]
    assert attributes.startswith("starter_crm_session=")
    for part in ("HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=43200"):
        assert part in attributes
    assert "Secure" not in attributes
    assert response.headers["Cache-Control"] == "no-store"


def test_production_uses_a_host_prefixed_secure_cookie(tmp_path):
    app = passcode_client(tmp_path, DC_ENV="production", DC_PUBLIC_URL="https://crm.example.com")
    response = sign_in(app, Origin="https://crm.example.com")
    assert response.headers["Set-Cookie"].startswith("__Host-starter_crm_session=")
    assert "Secure" in response.headers["Set-Cookie"]


def test_the_cookie_value_is_a_signed_payload_naming_the_owner(tmp_path):
    response = sign_in(passcode_client(tmp_path))
    payload = cookie_of(response).split("=", 1)[1].split(".")[0]
    claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    assert claims["v"] == 1
    assert claims["sub"] == str(uuid.uuid5(uuid.UUID(SITE_ID), "passcode|owner"))
    assert claims["exp"] - claims["iat"] == 43200


def test_the_cookie_lets_the_owner_through_and_tampering_does_not(tmp_path):
    app = passcode_client(tmp_path)
    cookie = cookie_of(sign_in(app))
    session = app.get("/api/auth/session", headers={"Cookie": cookie}).get_json()
    assert session["signed_in"] is True
    assert session["identity"] == "passcode"
    # The first character after the dot carries six full bits of the signature, so changing it always changes the MAC.
    head, _, mac = cookie.partition(".")
    tampered = head + "." + ("A" if mac[0] != "A" else "B") + mac[1:]
    assert app.get("/api/auth/session", headers={"Cookie": tampered}).get_json()["signed_in"] is False


def test_the_session_route_answers_200_when_signed_out(tmp_path):
    response = passcode_client(tmp_path).get("/api/auth/session")
    assert response.status_code == 200
    assert response.get_json() == {"identity": "passcode", "signed_in": False, "user": None}


def test_an_api_route_without_a_session_is_401_with_the_envelope(tmp_path):
    response = passcode_client(tmp_path).post("/api/dropcowboy/token", json={"purpose": "session"})
    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "unauthenticated"


def test_a_wrong_passcode_is_401_invalid_passcode(tmp_path):
    response = sign_in(passcode_client(tmp_path), passcode="not-the-passcode-at-all")
    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "invalid_passcode"
    assert PASSCODE not in response.get_data(as_text=True)


def test_sign_in_needs_json_and_a_trusted_origin(tmp_path):
    app = passcode_client(tmp_path)
    form = app.post("/api/auth/passcode", data="passcode=x", headers={"Origin": ORIGIN})
    assert form.status_code == 415
    foreign = sign_in(app, Origin="https://evil.example.org")
    assert foreign.status_code == 403
    assert foreign.get_json()["error"]["code"] == "csrf_rejected"


def test_with_no_origin_a_same_site_fetch_is_accepted_and_a_cross_site_one_is_not(tmp_path):
    app = passcode_client(tmp_path)
    ok = app.post("/api/auth/passcode", json={"passcode": PASSCODE}, headers={"Sec-Fetch-Site": "same-origin"})
    assert ok.status_code == 200
    cross = app.post("/api/auth/passcode", json={"passcode": PASSCODE}, headers={"Sec-Fetch-Site": "cross-site"})
    assert cross.status_code == 403


def test_sign_out_clears_the_cookie(tmp_path):
    response = passcode_client(tmp_path).post("/api/auth/signout", json={}, headers={"Origin": ORIGIN})
    assert response.status_code == 200
    assert response.get_json() == {"signed_in": False}
    assert "Max-Age=0" in response.headers["Set-Cookie"]


def test_sign_in_attempts_are_limited_per_ip(tmp_path):
    app = passcode_client(tmp_path)
    statuses = [sign_in(app, passcode="wrong-passcode-here").status_code for _ in range(11)]
    assert statuses[:10] == [401] * 10
    assert statuses[10] == 429


def test_a_configured_user_id_is_the_owner(tmp_path):
    owner = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
    app = passcode_client(tmp_path, STARTER_CRM_USER_ID=owner)
    cookie = cookie_of(sign_in(app))
    assert app.get("/api/auth/session", headers={"Cookie": cookie}).get_json()["user"]["id"] == owner
