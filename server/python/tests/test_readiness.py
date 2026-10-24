from __future__ import annotations

from helpers import API_KEY, API_SECRET, json_answer, make_client, make_config

from starter_crm.readiness import pick_readiness

ACCESS_TOKEN = "unit-test-access-token-0004"


def test_pick_readiness_keeps_only_the_fields_the_setup_page_shows():
    picked = pick_readiness(
        {
            "building_blocks_enabled": True,
            "usage_plan": "developer-plan",
            "pool_id": "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b",
            "byoc": {
                "connected": True,
                "pool_id": "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b",
                "providers": [
                    {
                        "provider": "twilio",
                        "integration_type": "twilio",
                        "integration_id": "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
                        "enabled": True,
                        "default": True,
                        "pool_id": "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b",
                    }
                ],
            },
            "numbers": {
                "count": 2,
                "items": [{"number_id": "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e", "phone_number": "+13125550142"}],
            },
            "voices": {"count": 1},
            "agents": {"count": 0, "published": 0},
            "funds": {"available": 12.5, "balance": 20, "reserved": 7.5, "funds_ok": True},
            "allotment": {
                "sms": {"remaining": 90, "cap": 100},
                "email": {"remaining": 5, "cap": 5, "extra": 1},
                "broken": {"remaining": "x"},
                "booleans": {"remaining": True, "cap": True},
            },
            "embed_ready": True,
            "next_actions": [],
            "embed_resolve_contact_consent": True,
        }
    )

    assert picked == {
        "embed_ready": True,
        "next_actions": [],
        "building_blocks_enabled": True,
        "byoc": {"connected": True, "providers": [{"provider": "twilio", "enabled": True, "default": True}]},
        "funds": {"available": 12.5, "funds_ok": True},
        "allotment": {"sms": {"remaining": 90, "cap": 100}, "email": {"remaining": 5, "cap": 5}},
        "numbers": {"count": 2},
        "embed_resolve_contact_consent": True,
        "sandbox_only": False,
    }


def test_pick_readiness_passes_sandbox_only_through_and_only_an_explicit_true_counts():
    assert pick_readiness({"sandbox_only": True})["sandbox_only"] is True
    assert pick_readiness({"sandbox_only": "true"})["sandbox_only"] is False
    assert pick_readiness({"sandbox_only": 1})["sandbox_only"] is False


def test_pick_readiness_fills_safe_defaults_including_the_consent_setting():
    assert pick_readiness(None) == {
        "embed_ready": False,
        "next_actions": [],
        "building_blocks_enabled": False,
        "byoc": {"connected": False, "providers": []},
        "funds": {"available": 0, "funds_ok": False},
        "allotment": {},
        "numbers": {"count": 0},
        "embed_resolve_contact_consent": False,
        "sandbox_only": False,
    }


def test_pick_readiness_treats_truthy_non_booleans_as_false():
    picked = pick_readiness({"embed_ready": 1, "building_blocks_enabled": "yes", "funds": {"available": True}})
    assert (picked["embed_ready"], picked["building_blocks_enabled"], picked["funds"]["available"]) == (False, False, 0)


def test_readiness_route_proxies_with_the_api_key(upstream):
    upstream.respond = lambda call: json_answer(200, {"data": {"embed_ready": True, "pool_id": "secret-pool"}})
    response = make_client(make_config(DROPCOWBOY_API_BASE=upstream.url)).get("/api/dropcowboy/readiness")

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.get_json()["embed_ready"] is True
    assert "secret-pool" not in response.get_data(as_text=True)
    call = upstream.calls[0]
    assert (call["method"], call["path"]) == ("GET", "/register/public/integration-readiness")
    assert (call["headers"]["x-key"], call["headers"]["x-secret"]) == (API_KEY, API_SECRET)
    assert "authorization" not in call["headers"]


def test_readiness_route_in_login_mode_forwards_the_access_token(upstream):
    upstream.respond = lambda call: json_answer(200, {"data": {"embed_ready": True}})
    client = make_client(make_config(DC_AUTH_MODE="login", DROPCOWBOY_API_BASE=upstream.url))
    response = client.get("/api/dropcowboy/readiness", headers={"Authorization": "Bearer " + ACCESS_TOKEN})

    assert response.status_code == 200
    call = upstream.calls[0]
    assert call["headers"]["authorization"] == "Bearer " + ACCESS_TOKEN
    assert "x-key" not in call["headers"]


def test_readiness_route_in_login_mode_needs_a_bearer(upstream):
    client = make_client(make_config(DC_AUTH_MODE="login", DROPCOWBOY_API_BASE=upstream.url))
    response = client.get("/api/dropcowboy/readiness")
    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "login_required"
    assert upstream.calls == []
