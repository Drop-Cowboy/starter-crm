"""Boot: every problem is named by code, and a working setup yields working instances."""

from __future__ import annotations

import pytest
from helpers import API_KEY, API_SECRET, SITE_ID, USER_ID, WEBHOOK_SECRET

from starter_crm.bootstrap import bootstrap

BASE = {
    "DC_AUTH_MODE": "server",
    "DROPCOWBOY_API_KEY": API_KEY,
    "DROPCOWBOY_API_SECRET": API_SECRET,
    "DROPCOWBOY_SITE_ID": SITE_ID,
    "DROPCOWBOY_WEBHOOK_SECRET": WEBHOOK_SECRET,
    "STARTER_CRM_USER_ID": USER_ID,
}

GOOD_PASSCODE = "a-long-enough-passcode"
GOOD_OIDC = {"DC_OIDC_ISSUER": "https://issuer.example.com", "DC_OIDC_AUDIENCE": "starter-crm"}


def codes(tmp_path, **env):
    booted = bootstrap({**BASE, **env}, tmp_path)
    return [item.code for item in booted.problems]


@pytest.mark.parametrize(
    ("env", "code"),
    [
        ({"DC_IDENTITY": "bogus"}, "invalid_identity"),
        ({"DC_IDENTITY": "passcode"}, "missing_passcode"),
        ({"DC_IDENTITY": "passcode", "DC_PASSCODE": "short-pass"}, "weak_passcode"),
        ({"DC_IDENTITY": "oidc", "DC_OIDC_AUDIENCE": "a"}, "missing_oidc_issuer"),
        ({"DC_IDENTITY": "oidc", "DC_OIDC_ISSUER": "https://issuer.example.com"}, "missing_oidc_audience"),
        (
            {"DC_IDENTITY": "oidc", "DC_OIDC_ISSUER": "http://issuer.example.com", "DC_OIDC_AUDIENCE": "a"},
            "invalid_oidc_issuer",
        ),
        ({"DC_LOG_FORMAT": "xml"}, "invalid_log_format"),
        ({"DC_LOG_REQUESTS": "maybe"}, "invalid_log_requests"),
        ({"DC_CSP": "sometimes"}, "invalid_csp"),
        ({"DC_CORS_ORIGINS": "*"}, "invalid_cors_origins"),
        ({"DC_RATE_LIMIT": "distributed"}, "invalid_rate_limit"),
        ({"DC_RATE_LIMIT": "redis"}, "missing_redis_url"),
        ({"DC_TOKEN_CACHE": "maybe"}, "invalid_token_cache"),
        ({"DC_SECRETS": "nonexistent"}, "invalid_secrets_provider"),
        ({"DC_SECRETS": "file"}, "missing_secrets_dir"),
        ({"DC_LOG": "./does-not-exist.py"}, "invalid_provider"),
    ],
)
def test_each_bad_setting_is_reported_by_its_code(tmp_path, env, code):
    assert code in codes(tmp_path, **env)


def test_passcode_identity_is_only_for_server_mode(tmp_path):
    found = codes(tmp_path, DC_AUTH_MODE="login", DC_IDENTITY="passcode", DC_PASSCODE=GOOD_PASSCODE)
    assert "identity_requires_server_mode" in found


def test_the_dev_identity_is_refused_in_production(tmp_path):
    assert "production_dev_identity" in codes(tmp_path, DC_ENV="production")


def test_the_user_id_is_only_required_for_the_dev_identity(tmp_path):
    assert "missing_user_id" in codes(tmp_path, STARTER_CRM_USER_ID="")
    assert codes(tmp_path, STARTER_CRM_USER_ID="", DC_IDENTITY="passcode", DC_PASSCODE=GOOD_PASSCODE) == []


def test_a_good_setup_boots_with_working_instances(tmp_path):
    booted = bootstrap({**BASE, "DC_IDENTITY": "passcode", "DC_PASSCODE": GOOD_PASSCODE}, tmp_path)
    assert booted.problems == []
    assert booted.identity is not None
    assert booted.ratelimit.hit("k", 1, 60)["allowed"] is True
    assert booted.observer is None


def test_the_oidc_identity_boots_without_contacting_the_issuer(tmp_path):
    booted = bootstrap({**BASE, "DC_IDENTITY": "oidc", **GOOD_OIDC}, tmp_path)
    assert booted.problems == []


def test_a_file_secrets_provider_supplies_the_credentials_and_they_are_never_logged(tmp_path):
    secrets = tmp_path / "secrets"
    secrets.mkdir()
    for name, value in {"DROPCOWBOY_API_KEY": "file-key-0001", "DROPCOWBOY_API_SECRET": "file-secret-0002"}.items():
        (secrets / name).write_text(value + "\n")
        (secrets / name).chmod(0o600)
    env = {key: value for key, value in BASE.items() if key not in ("DROPCOWBOY_API_KEY", "DROPCOWBOY_API_SECRET")}
    booted = bootstrap({**env, "DC_SECRETS": "file", "DC_SECRETS_DIR": str(secrets)}, tmp_path)
    assert booted.problems == []
    assert booted.config.api_key == "file-key-0001"
    assert "file-key-0001" in booted.config.known_secrets


def test_a_secrets_provider_that_raises_is_secret_load_failed_without_the_value(tmp_path):
    file = tmp_path / "secrets.py"
    file.write_text(
        "name = 'broken'\nconfig_keys = []\n"
        "def validate(env):\n    return []\n"
        "class S:\n    def load(self, names):\n        raise RuntimeError('vault is down')\n"
        "def create(ctx):\n    return S()\n"
    )
    booted = bootstrap({**BASE, "DC_SECRETS": "./secrets.py"}, tmp_path)
    assert [item.code for item in booted.problems] == ["secret_load_failed"]
    assert "vault is down" in booted.problems[0].message
