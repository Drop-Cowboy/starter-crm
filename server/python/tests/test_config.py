from __future__ import annotations

import pytest
from helpers import API_KEY, API_SECRET, SITE_ID, USER_ID, WEBHOOK_SECRET, make_config

from starter_crm.app import public_config
from starter_crm.config import load_config


def test_defaults_to_server_mode_on_loopback_port_8080():
    config, problems = load_config(
        {
            "DROPCOWBOY_SITE_ID": SITE_ID,
            "DROPCOWBOY_API_KEY": API_KEY,
            "DROPCOWBOY_API_SECRET": API_SECRET,
            "STARTER_CRM_USER_ID": USER_ID,
        }
    )
    assert problems == []
    assert (config.mode, config.host, config.port, config.api_base) == (
        "server",
        "127.0.0.1",
        8080,
        "https://api-v2.dropcowboy.com",
    )


def test_requires_only_the_site_id_in_login_mode():
    _, problems = load_config({"DC_AUTH_MODE": "login"})
    assert problems == ["DROPCOWBOY_SITE_ID is required when DC_AUTH_MODE=login."]


def test_names_every_missing_variable_in_server_mode():
    _, problems = load_config({"DC_AUTH_MODE": "server"})
    text = "\n".join(problems)
    for name in ["DROPCOWBOY_API_KEY", "DROPCOWBOY_API_SECRET", "DROPCOWBOY_SITE_ID", "STARTER_CRM_USER_ID"]:
        assert name in text


def test_requires_a_uuid_for_the_sample_user():
    _, problems = load_config(
        {
            "DC_AUTH_MODE": "server",
            "DROPCOWBOY_API_KEY": "k",
            "DROPCOWBOY_API_SECRET": "s",
            "DROPCOWBOY_SITE_ID": SITE_ID,
            "STARTER_CRM_USER_ID": "user-1",
        }
    )
    assert problems == ["STARTER_CRM_USER_ID must be a UUID."]


@pytest.mark.parametrize("mode", ["login", "server", "mcp-session"])
def test_rejects_a_non_uuid_site_id_in_every_mode(mode):
    _, problems = load_config(
        {
            "DC_AUTH_MODE": mode,
            "DROPCOWBOY_API_KEY": "k",
            "DROPCOWBOY_API_SECRET": "s",
            "DROPCOWBOY_SITE_ID": "my-site",
            "STARTER_CRM_USER_ID": USER_ID,
        }
    )
    assert len(problems) == 1
    assert problems[0].startswith("DROPCOWBOY_SITE_ID must be a UUID")
    assert "400 invalid_site_id" in problems[0]


def test_accepts_a_uuid_site_id_of_any_version():
    _, problems = load_config(
        {
            "DC_AUTH_MODE": "login",
            "DROPCOWBOY_SITE_ID": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        }
    )
    assert problems == []


def test_rejects_an_unknown_mode_without_echoing_secrets():
    _, problems = load_config({"DC_AUTH_MODE": "open", "DROPCOWBOY_API_SECRET": API_SECRET})
    assert len(problems) == 1
    assert API_SECRET not in problems[0]


def test_trims_and_splits_webhook_secrets():
    config, _ = load_config({"DROPCOWBOY_WEBHOOK_SECRET": " first-secret , second-secret ,, "})
    assert config.webhook_secrets == ("first-secret", "second-secret")


@pytest.mark.parametrize(
    "name, value",
    [
        ("PORT", "eighty"),
        ("PORT", "70000"),
        ("PORT", "٣"),
        ("DROPCOWBOY_TIMEOUT_MS", "0"),
        ("DROPCOWBOY_TIMEOUT_MS", "1.5"),
        ("DROPCOWBOY_API_BASE", "ftp://api.example.test"),
    ],
)
def test_rejects_malformed_numbers_and_urls(name, value):
    _, problems = load_config({
        "DC_AUTH_MODE": "login",
        "DROPCOWBOY_SITE_ID": SITE_ID,
        name: value,
    })
    assert len(problems) == 1
    assert name in problems[0]


def test_public_config_never_contains_a_secret():
    for mode in ["login", "server", "mcp-session"]:
        text = str(public_config(make_config(DC_AUTH_MODE=mode)))
        for secret in [API_KEY, API_SECRET, WEBHOOK_SECRET]:
            assert secret not in text


def test_public_config_includes_auth0_only_in_login_mode():
    assert public_config(make_config(DC_AUTH_MODE="login"))["auth0"] == {
        "domain": "login.dropcowboy.com",
        "client_id": None,
        "audience": "https://api-v2.dropcowboy.com",
    }
    assert public_config(make_config())["auth0"] is None
