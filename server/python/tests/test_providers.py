"""The provider loader, the conformance check, and what happens to a provider that is wrong."""

from __future__ import annotations

from pathlib import Path

import pytest

from starter_crm.provider_check import check_provider
from starter_crm.providers import BUILTINS, resolve_provider

PASSCODE = {"DC_PASSCODE": "a-long-enough-passcode"}
OIDC = {"DC_OIDC_ISSUER": "https://issuer.example.com", "DC_OIDC_AUDIENCE": "starter-crm"}
BUILTIN_SETTINGS = {"passcode": PASSCODE, "oidc": OIDC}


# These read a remote manager, so the check needs one to talk to; test_secret_managers.py runs it against stand-ins.
NEEDS_A_MANAGER = {"doppler", "infisical", "1password", "vault", "aws-secrets-manager", "aws-ssm"}


# The conformance check covers the five provider kinds a customer writes. The event store, fan-out and webhook modes
# are exercised by test_stores.py, test_fanouts.py and test_webhook_modes.py (and live, by the conformance suite).
CHECKED_KINDS = {"identity", "secrets", "ratelimit", "log", "observer"}


def cases():
    for kind, modules in BUILTINS.items():
        if kind not in CHECKED_KINDS:
            continue
        for name in modules:
            if kind == "ratelimit" and name == "redis":
                continue
            if kind == "secrets" and name in NEEDS_A_MANAGER:
                continue
            yield kind, name


@pytest.mark.parametrize(("kind", "name"), list(cases()))
def test_every_builtin_passes_the_conformance_check(kind, name, tmp_path):
    settings = dict(BUILTIN_SETTINGS.get(name) or {})
    settings["DC_SECRETS_DIR"] = str(tmp_path)
    results = check_provider(kind, name, settings)
    failures = [item for item in results if not item["ok"]]
    assert failures == []
    assert len(results) >= 4


ALLOW_ALL_CLASS = (
    "class L:\n"
    "    def hit(self, key, limit, window):\n"
    "        return {'allowed': True, 'remaining': limit, 'retry_after_seconds': 1}\n"
)


def write(tmp_path: Path, text: str) -> Path:
    file = tmp_path / "provider.py"
    file.write_text(text, encoding="utf-8")
    return file


def test_a_custom_ratelimit_provider_is_checked_like_a_builtin(tmp_path):
    file = write(
        tmp_path,
        "name = 'allow-all'\nconfig_keys = []\nnever_limits = True\n"
        "def validate(env):\n    return []\n" + ALLOW_ALL_CLASS + "def create(ctx):\n    return L()\n",
    )
    assert all(item["ok"] for item in check_provider("ratelimit", file))


def test_a_limiter_that_never_refuses_fails_unless_it_says_so(tmp_path):
    file = write(
        tmp_path,
        "name = 'allow-all'\nconfig_keys = []\n"
        "def validate(env):\n    return []\n" + ALLOW_ALL_CLASS + "def create(ctx):\n    return L()\n",
    )
    failed = [item for item in check_provider("ratelimit", file) if not item["ok"]]
    assert [item["name"][:5] for item in failed] == ["hit()"]


def test_a_file_missing_create_is_reported_by_name(tmp_path):
    file = write(tmp_path, "name = 'x'\nconfig_keys = []\ndef validate(env):\n    return []\n")
    failed = [item for item in check_provider("log", file) if not item["ok"]]
    assert failed[0]["name"].startswith("defines name")
    assert "create" in failed[0]["detail"]


def test_a_file_that_does_not_import_fails_the_load_check(tmp_path):
    file = write(tmp_path, "import not_a_real_module_anywhere\n")
    results = check_provider("log", file)
    assert results[0]["ok"] is False
    assert results[0]["name"] == "the file loads"


def test_an_unknown_kind_is_rejected():
    assert check_provider("bogus", "x")[0]["ok"] is False


def test_an_async_observer_hook_is_flagged_because_python_calls_hooks_synchronously(tmp_path):
    file = write(
        tmp_path,
        "name = 'o'\nconfig_keys = []\ndef validate(env):\n    return []\n"
        "class O:\n    async def on_request(self, payload):\n        pass\n"
        "def create(ctx):\n    return O()\n",
    )
    failed = [item for item in check_provider("observer", file) if not item["ok"]]
    assert failed and "synchronous" in failed[0]["name"]


def test_an_identity_test_vector_runs_against_the_instance(tmp_path):
    file = write(
        tmp_path,
        "name = 'hdr'\nconfig_keys = []\n"
        "test_vectors = [{'name': 'good', 'headers': {'X-User': 'abc'}, 'expect': {'id': 'abc'}},"
        " {'name': 'none', 'headers': {}, 'expect': None}]\n"
        "def validate(env):\n    return []\n"
        "class I:\n    def authenticate(self, request):\n"
        "        value = request.headers.get('x-user')\n        return {'id': value} if value else None\n"
        "def create(ctx):\n    return I()\n",
    )
    results = check_provider("identity", file)
    assert all(item["ok"] for item in results)
    assert any(item["name"] == "test_vectors: good" for item in results)


def test_resolve_provider_names_an_unknown_builtin(tmp_path):
    module, bad = resolve_provider("identity", "nope", tmp_path)
    assert module is None
    assert bad.code == "unknown_provider"


def test_resolve_provider_reports_a_file_that_cannot_load(tmp_path):
    module, bad = resolve_provider("log", "./missing.py", tmp_path)
    assert module is None
    assert bad.code == "invalid_provider"


def test_resolve_provider_returns_none_for_no_observer(tmp_path):
    assert resolve_provider("observer", None, tmp_path) == (None, None)
