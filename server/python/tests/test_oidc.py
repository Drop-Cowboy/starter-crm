"""The oidc identity against a stand-in issuer: keys, claims, and the failure modes."""

from __future__ import annotations

import json
import time
import uuid

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from helpers import SITE_ID, FakeUpstream, json_answer, make_booted_client
from jwt.algorithms import ECAlgorithm, RSAAlgorithm

AUDIENCE = "starter-crm"
RSA_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
EC_KEY = ec.generate_private_key(ec.SECP256R1())


def jwk(key, kid, algorithm):
    exported = json.loads((RSAAlgorithm if algorithm == "RS256" else ECAlgorithm).to_jwk(key.public_key()))
    exported.update({"kid": kid, "use": "sig", "alg": algorithm})
    return exported


@pytest.fixture
def issuer():
    fake = FakeUpstream()
    keys = [jwk(RSA_KEY, "rsa-1", "RS256"), jwk(EC_KEY, "ec-1", "ES256")]

    def respond(call):
        if call["path"] == "/.well-known/openid-configuration":
            return json_answer(200, {"issuer": fake.url, "jwks_uri": fake.url + "/keys"})
        if call["path"] == "/keys":
            return json_answer(200, {"keys": keys})
        return json_answer(404, {})

    fake.respond = respond
    fake.keys = keys
    yield fake
    fake.close()


def oidc_client(tmp_path, fake):
    return make_booted_client(
        tmp_path,
        DC_IDENTITY="oidc",
        DC_OIDC_ISSUER=fake.url,
        DC_OIDC_AUDIENCE=AUDIENCE,
        STARTER_CRM_USER_ID="",
    )[0]


def token(fake, key=RSA_KEY, algorithm="RS256", kid="rsa-1", **claims):
    body = {"iss": fake.url, "aud": AUDIENCE, "sub": "user-1", "exp": int(time.time()) + 600}
    body.update(claims)
    return jwt.encode({k: v for k, v in body.items() if v is not None}, key, algorithm=algorithm, headers={"kid": kid})


def whoami(app, bearer):
    return app.get("/api/auth/session", headers={"Authorization": "Bearer " + bearer})


def protected(app, bearer):
    return app.post("/api/dropcowboy/token", json={"purpose": "session"}, headers={"Authorization": "Bearer " + bearer})


def test_a_valid_rs256_token_signs_the_user_in_with_a_derived_uuid(tmp_path, issuer):
    app = oidc_client(tmp_path, issuer)
    session = whoami(app, token(issuer, email="jane@example.com", name="Jane")).get_json()
    assert session["signed_in"] is True
    assert session["user"]["id"] == str(uuid.uuid5(uuid.UUID(SITE_ID), issuer.url + "|user-1"))
    assert session["user"]["email"] == "jane@example.com"
    assert session["user"]["name"] == "Jane"


def test_a_valid_es256_token_is_accepted(tmp_path, issuer):
    bearer = token(issuer, key=EC_KEY, algorithm="ES256", kid="ec-1")
    assert whoami(oidc_client(tmp_path, issuer), bearer).get_json()["signed_in"] is True


def test_a_uuid_subject_is_used_as_is_in_lower_case(tmp_path, issuer):
    subject = "7C1D2E3F-4A5B-4C6D-8E7F-9A0B1C2D3E4F"
    session = whoami(oidc_client(tmp_path, issuer), token(issuer, sub=subject)).get_json()
    assert session["user"]["id"] == subject.lower()


@pytest.mark.parametrize(
    "claims",
    [
        {"aud": "someone-else"},
        {"iss": "https://other.example.com"},
        {"exp": int(time.time()) - 3600},
        {"exp": None},
        {"sub": None},
    ],
    ids=["audience", "issuer", "expired", "no-exp", "no-sub"],
)
def test_a_token_that_fails_a_claim_is_401_invalid_token(tmp_path, issuer, claims):
    response = oidc_client(tmp_path, issuer).post(
        "/api/dropcowboy/token",
        json={"purpose": "session"},
        headers={"Authorization": "Bearer " + token(issuer, **claims)},
    )
    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "invalid_token"
    assert response.headers["WWW-Authenticate"].startswith("Bearer")


def test_a_token_signed_with_an_unlisted_key_is_rejected(tmp_path, issuer):
    stranger = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    response = protected(oidc_client(tmp_path, issuer), token(issuer, key=stranger, kid="rsa-1"))
    assert response.status_code == 401


def test_an_hs256_token_is_refused_to_stop_algorithm_confusion(tmp_path, issuer):
    forged = jwt.encode(
        {"iss": issuer.url, "aud": AUDIENCE, "sub": "x", "exp": int(time.time()) + 600},
        "a-shared-secret-that-is-long-enough-for-hs256",
        algorithm="HS256",
        headers={"kid": "rsa-1"},
    )
    assert protected(oidc_client(tmp_path, issuer), forged).status_code == 401


def test_the_none_algorithm_is_refused(tmp_path, issuer):
    unsigned = jwt.encode({"iss": issuer.url, "aud": AUDIENCE, "sub": "x", "exp": int(time.time()) + 600}, None, "none")
    assert protected(oidc_client(tmp_path, issuer), unsigned).status_code == 401


def test_without_a_token_a_protected_route_is_401_unauthenticated_with_a_challenge(tmp_path, issuer):
    response = oidc_client(tmp_path, issuer).post("/api/dropcowboy/token", json={"purpose": "session"})
    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "unauthenticated"
    assert response.headers["WWW-Authenticate"] == "Bearer"


def test_an_unreachable_issuer_is_503_identity_unavailable(tmp_path, issuer):
    app = oidc_client(tmp_path, issuer)
    bearer = token(issuer)
    issuer.respond = lambda call: json_answer(500, {})
    response = app.post(
        "/api/dropcowboy/token", json={"purpose": "session"}, headers={"Authorization": "Bearer " + bearer}
    )
    assert response.status_code == 503
    assert response.get_json()["error"]["code"] == "identity_unavailable"


def test_keys_are_cached_so_a_second_request_does_not_refetch(tmp_path, issuer):
    app = oidc_client(tmp_path, issuer)
    bearer = token(issuer)
    whoami(app, bearer)
    whoami(app, bearer)
    assert [call["path"] for call in issuer.calls].count("/keys") == 1
