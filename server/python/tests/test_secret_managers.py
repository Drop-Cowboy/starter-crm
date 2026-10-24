"""The doppler, infisical, vault and 1password secrets providers, against stand-ins.

Mirrors server/conformance/suite/19-secret-managers.test.js and
server/node/test/secret-managers.test.js: the same stand-in behaviour, the
same expectations, so the two servers cannot drift apart.
"""

from __future__ import annotations

import http.server
import os
import threading
import uuid
from types import SimpleNamespace

import boto3
import pytest
import stub_managers
from helpers import API_KEY, API_SECRET, SITE_ID, USER_ID, WEBHOOK_SECRET

from starter_crm.bootstrap import bootstrap
from starter_crm.provider_check import check_provider
from starter_crm.providers.secrets import aws_secrets_manager, aws_ssm, doppler, infisical, onepassword, vault
from starter_crm.providers.secrets._http import ManagerError

NAMES = ["DROPCOWBOY_API_KEY", "DROPCOWBOY_API_SECRET", "DROPCOWBOY_WEBHOOK_SECRET", "DC_PASSCODE"]


def served(webhook: str = WEBHOOK_SECRET) -> dict[str, str]:
    """What a manager holds: the three secrets, and one the starter must ignore."""
    return {
        "DROPCOWBOY_API_KEY": API_KEY,
        "DROPCOWBOY_API_SECRET": API_SECRET,
        "DROPCOWBOY_WEBHOOK_SECRET": webhook,
        "UNRELATED_SECRET": "unrelated-" + str(uuid.uuid4()),
    }


def ctx(env: dict[str, str]):
    return SimpleNamespace(env=env)


@pytest.fixture
def stubs(monkeypatch):
    """Collects the stand-ins a test starts, and stops them afterwards; ``stubs.monkeypatch`` sets process settings."""
    started = []

    def keep(stub):
        started.append(stub)
        return stub

    keep.monkeypatch = monkeypatch
    yield keep
    for stub in started:
        stub.close()


def doppler_setup(stubs, secrets=None):
    token = "dp.st." + str(uuid.uuid4())
    stub = stubs(stub_managers.doppler(token, secrets or served()))
    return stub, {"DC_SECRETS": "doppler", "DOPPLER_TOKEN": token, "DOPPLER_API_URL": stub.url}


def infisical_setup(stubs, secrets=None, expires_in=3600):
    ids = {"client_id": str(uuid.uuid4()), "client_secret": "cs-" + str(uuid.uuid4()), "project_id": str(uuid.uuid4())}
    stub = stubs(stub_managers.infisical(environment="prod", secrets=secrets or served(), expires_in=expires_in, **ids))
    return stub, {
        "DC_SECRETS": "infisical",
        "INFISICAL_URL": stub.url,
        "INFISICAL_CLIENT_ID": ids["client_id"],
        "INFISICAL_CLIENT_SECRET": ids["client_secret"],
        "INFISICAL_PROJECT_ID": ids["project_id"],
    }


def vault_token_setup(stubs, secrets=None):
    token = "hvs." + str(uuid.uuid4())
    stub = stubs(stub_managers.vault("starter-crm", secrets or served(), token=token))
    return stub, {"DC_SECRETS": "vault", "VAULT_ADDR": stub.url, "VAULT_TOKEN": token, "VAULT_PATH": "starter-crm"}


def vault_approle_setup(stubs, secrets=None):
    role_id, secret_id = str(uuid.uuid4()), "sid-" + str(uuid.uuid4())
    stub = stubs(stub_managers.vault("apps/starter-crm", secrets or served(), role_id=role_id, secret_id=secret_id))
    return stub, {
        "DC_SECRETS": "vault",
        "VAULT_ADDR": stub.url,
        "VAULT_ROLE_ID": role_id,
        "VAULT_SECRET_ID": secret_id,
        "VAULT_PATH": "apps/starter-crm",
    }


def aws_credentials(stubs):
    """boto3 reads its credentials from the process, not from the settings the starter passes, so a test sets them."""
    access_key_id = "AKIA" + uuid.uuid4().hex[:16].upper()
    secret_access_key = "aws-secret-key-" + str(uuid.uuid4())
    stubs.monkeypatch.setenv("AWS_ACCESS_KEY_ID", access_key_id)
    stubs.monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", secret_access_key)
    # boto3 resolves credentials once per default session, so a test that changes them starts a new one.
    stubs.monkeypatch.setattr(boto3, "DEFAULT_SESSION", None)
    return access_key_id, secret_access_key


def aws_secrets_manager_setup(stubs, secrets=None):
    access_key_id, _ = aws_credentials(stubs)
    stub = stubs(stub_managers.aws_secrets_manager(access_key_id, "starter-crm/prod", secrets or served()))
    return stub, {
        "DC_SECRETS": "aws-secrets-manager",
        "DC_AWS_SECRET_ID": "starter-crm/prod",
        "AWS_REGION": "us-east-1",
        "AWS_ENDPOINT_URL_SECRETS_MANAGER": stub.url,
    }


def aws_ssm_setup(stubs, secrets=None):
    access_key_id, _ = aws_credentials(stubs)
    stub = stubs(stub_managers.aws_ssm(access_key_id, "/starter-crm", secrets or served()))
    return stub, {
        "DC_SECRETS": "aws-ssm",
        "DC_AWS_SSM_PATH": "/starter-crm",
        "AWS_REGION": "us-east-1",
        "AWS_ENDPOINT_URL_SSM": stub.url,
    }


SETUPS = {
    "doppler": (doppler, doppler_setup),
    "infisical": (infisical, infisical_setup),
    "vault-token": (vault, vault_token_setup),
    "vault-approle": (vault, vault_approle_setup),
    "aws-secrets-manager": (aws_secrets_manager, aws_secrets_manager_setup),
    "aws-ssm": (aws_ssm, aws_ssm_setup),
}


@pytest.mark.parametrize("which", list(SETUPS))
def test_loads_only_the_names_asked_for(stubs, which):
    module, setup = SETUPS[which]
    stub, env = setup(stubs)
    values = module.create(ctx(env)).load(NAMES)
    assert values == {
        "DROPCOWBOY_API_KEY": API_KEY,
        "DROPCOWBOY_API_SECRET": API_SECRET,
        "DROPCOWBOY_WEBHOOK_SECRET": WEBHOOK_SECRET,
    }
    assert "UNRELATED_SECRET" not in values


@pytest.mark.parametrize("which", list(SETUPS))
def test_refresh_sees_a_rotated_value(stubs, which):
    module, setup = SETUPS[which]
    stub, env = setup(stubs)
    provider = module.create(ctx(env))
    provider.load(NAMES)
    stub.secrets["DROPCOWBOY_WEBHOOK_SECRET"] = "rotated-" + str(uuid.uuid4())
    assert provider.refresh()["DROPCOWBOY_WEBHOOK_SECRET"] == stub.secrets["DROPCOWBOY_WEBHOOK_SECRET"]


@pytest.mark.parametrize("which", list(SETUPS))
def test_an_outage_raises_with_the_status_and_no_credential(stubs, which):
    module, setup = SETUPS[which]
    stub, env = setup(stubs)
    provider = module.create(ctx(env))
    provider.load(NAMES)
    stub.failing = 503
    with pytest.raises(ManagerError) as caught:
        provider.refresh()
    assert "HTTP 503" in str(caught.value)
    for key in ("DOPPLER_TOKEN", "INFISICAL_CLIENT_SECRET", "VAULT_TOKEN", "VAULT_SECRET_ID"):
        if key in env:
            assert env[key] not in str(caught.value)
    assert os.environ.get("AWS_SECRET_ACCESS_KEY", "-") not in str(caught.value)


@pytest.mark.parametrize("which", list(SETUPS))
def test_a_wrong_credential_is_a_named_failure(stubs, which):
    module, setup = SETUPS[which]
    stub, env = setup(stubs)
    key = {"doppler": "DOPPLER_TOKEN", "infisical": "INFISICAL_CLIENT_SECRET"}.get(
        which, "VAULT_TOKEN" if which == "vault-token" else "VAULT_SECRET_ID"
    )
    wrong = "wrong-" + str(uuid.uuid4())
    if which.startswith("aws-"):
        stubs.monkeypatch.setenv("AWS_ACCESS_KEY_ID", wrong)
        stubs.monkeypatch.setattr(boto3, "DEFAULT_SESSION", None)
        key = "AWS_ACCESS_KEY_ID"
    with pytest.raises(ManagerError) as caught:
        module.create(ctx({**env, key: wrong})).load(NAMES)
    assert caught.value.status in (400, 401, 403)
    assert wrong not in str(caught.value)


@pytest.mark.parametrize("which", list(SETUPS))
def test_an_unreachable_manager_is_a_named_failure(stubs, which):
    module, setup = SETUPS[which]
    stub, env = setup(stubs)
    stub.close()
    with pytest.raises(ManagerError, match="could not be reached"):
        module.create(ctx(env)).load(NAMES)


@pytest.mark.parametrize("which", list(SETUPS))
def test_the_provider_passes_the_conformance_check(stubs, which):
    module, setup = SETUPS[which]
    stub, env = setup(stubs)
    results = check_provider("secrets", module.name, env)
    assert [item for item in results if not item["ok"]] == []


def test_a_redirect_is_refused_and_not_followed(stubs):
    followed = []

    class Target(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            followed.append(self.path)
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args):
            return None

    target = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Target)
    threading.Thread(target=target.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()

    class Redirector(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:" + str(target.server_address[1]) + "/stolen")
            self.end_headers()

        def log_message(self, *args):
            return None

    redirector = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Redirector)
    threading.Thread(target=redirector.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
    try:
        env = {"DOPPLER_TOKEN": "dp.st.x", "DOPPLER_API_URL": "http://127.0.0.1:" + str(redirector.server_address[1])}
        with pytest.raises(ManagerError, match="redirect"):
            doppler.create(ctx(env)).load(NAMES)
        assert followed == []
    finally:
        redirector.shutdown()
        target.shutdown()


def test_infisical_signs_in_again_after_a_401_exactly_once(stubs):
    stub, env = infisical_setup(stubs)
    provider = infisical.create(ctx(env))
    provider.load(NAMES)
    assert stub.logins == 1
    stub.revoke_tokens()
    provider.refresh()
    assert stub.logins == 2


def test_infisical_signs_in_again_once_the_token_has_expired(stubs):
    stub, env = infisical_setup(stubs, expires_in=3600)
    clock = [1000.0]
    provider = infisical.InfisicalSecrets(env, now=lambda: clock[0])
    provider.load(NAMES)
    provider.refresh()
    assert stub.logins == 1
    clock[0] += 3600
    provider.refresh()
    assert stub.logins == 2


def test_vault_approle_logs_in_again_after_a_403_exactly_once(stubs):
    stub, env = vault_approle_setup(stubs)
    provider = vault.create(ctx(env))
    provider.load(NAMES)
    assert stub.logins == 1
    stub.revoke_tokens()
    provider.refresh()
    assert stub.logins == 2


def test_vault_a_static_token_is_not_retried_on_403(stubs):
    stub, env = vault_token_setup(stubs)
    provider = vault.create(ctx({**env, "VAULT_TOKEN": "revoked"}))
    with pytest.raises(ManagerError, match="HTTP 403"):
        provider.load(NAMES)
    assert len(stub.requests) == 1


def test_vault_names_the_mount_and_path_when_the_secret_is_missing(stubs):
    stub, env = vault_token_setup(stubs)
    with pytest.raises(ManagerError, match=r"secret/typo-crm"):
        vault.create(ctx({**env, "VAULT_PATH": "typo-crm"})).load(NAMES)


def test_vault_sends_the_namespace_header(stubs):
    token = "hvs." + str(uuid.uuid4())
    stub = stubs(stub_managers.vault("starter-crm", served(), token=token, namespace="team-a"))
    env = {"VAULT_ADDR": stub.url, "VAULT_TOKEN": token, "VAULT_PATH": "starter-crm", "VAULT_NAMESPACE": "team-a"}
    assert vault.create(ctx(env)).load(NAMES)["DROPCOWBOY_API_KEY"] == API_KEY


@pytest.mark.parametrize(
    ("module", "env", "code"),
    [
        (doppler, {}, "missing_doppler_token"),
        (doppler, {"DOPPLER_TOKEN": "t", "DOPPLER_API_URL": "http://secrets.example.com"}, "invalid_secrets_url"),
        (doppler, {"DOPPLER_TOKEN": "t", "DOPPLER_API_URL": "not a url"}, "invalid_secrets_url"),
        (doppler, {"DOPPLER_TOKEN": "t", "DOPPLER_API_URL": "https://user:pw@api.example.com"}, "invalid_secrets_url"),
        (infisical, {}, "missing_infisical_setting"),
        (
            infisical,
            {
                "INFISICAL_CLIENT_ID": "a",
                "INFISICAL_CLIENT_SECRET": "b",
                "INFISICAL_PROJECT_ID": "c",
                "INFISICAL_URL": "http://infisical.example.com",
            },
            "invalid_secrets_url",
        ),
        (vault, {}, "missing_vault_setting"),
        (
            vault,
            {"VAULT_ADDR": "https://v.example.com", "VAULT_PATH": "p", "VAULT_ROLE_ID": "r"},
            "missing_vault_setting",
        ),
        (
            vault,
            {
                "VAULT_ADDR": "https://v.example.com",
                "VAULT_PATH": "p",
                "VAULT_TOKEN": "t",
                "VAULT_ROLE_ID": "r",
                "VAULT_SECRET_ID": "s",
            },
            "invalid_vault_auth",
        ),
        (
            vault,
            {"VAULT_ADDR": "http://v.example.com:8200", "VAULT_PATH": "p", "VAULT_TOKEN": "t"},
            "invalid_secrets_url",
        ),
        (
            vault,
            {"VAULT_ADDR": "https://v.example.com", "VAULT_PATH": "a/../b", "VAULT_TOKEN": "t"},
            "invalid_vault_path",
        ),
        (aws_secrets_manager, {"AWS_REGION": "us-east-1"}, "missing_aws_secret_id"),
        (aws_secrets_manager, {"DC_AWS_SECRET_ID": "starter-crm/prod"}, "missing_aws_region"),
        (aws_ssm, {"AWS_REGION": "us-east-1"}, "missing_aws_ssm_path"),
        (aws_ssm, {"AWS_REGION": "us-east-1", "DC_AWS_SSM_PATH": "no-leading-slash"}, "invalid_aws_ssm_path"),
        (
            aws_ssm,
            {"AWS_REGION": "us-east-1", "DC_AWS_SSM_PATH": "/starter-crm", "AWS_ENDPOINT_URL": "not a url"},
            "invalid_aws_endpoint",
        ),
        (
            aws_ssm,
            {
                "AWS_REGION": "us-east-1",
                "DC_AWS_SSM_PATH": "/starter-crm",
                "AWS_ENDPOINT_URL": "http://ssm.example.com",
                "DC_ENV": "production",
            },
            "insecure_aws_endpoint",
        ),
        (onepassword, {}, "missing_onepassword_setting"),
        (
            onepassword,
            {"OP_SERVICE_ACCOUNT_TOKEN": "t", "OP_VAULT": "a/b"},
            "invalid_onepassword_setting",
        ),
        (
            onepassword,
            {"OP_SERVICE_ACCOUNT_TOKEN": "t", "OP_VAULT": "v", "OP_ITEM": "i?x"},
            "invalid_onepassword_setting",
        ),
    ],
)
def test_each_bad_setting_is_reported_by_its_code(module, env, code):
    assert code in [item.code for item in module.validate(env)]


@pytest.mark.parametrize(
    "env",
    [
        {"DOPPLER_TOKEN": "t", "DOPPLER_API_URL": "http://localhost:9999"},
        {"DOPPLER_TOKEN": "t", "DOPPLER_API_URL": "http://127.0.0.1:9999"},
        {"DOPPLER_TOKEN": "t", "DOPPLER_API_URL": "https://api.doppler.com"},
        {"DOPPLER_TOKEN": "t"},
    ],
)
def test_https_or_loopback_is_accepted(env):
    assert doppler.validate(env) == []


class FakeOnePassword:
    """A signed-in client over a dict of references to values."""

    def __init__(self, items: dict[str, str]):
        self.items = items
        self.secrets = self

    async def resolve(self, reference: str) -> str:
        if reference not in self.items:
            raise RuntimeError('the secret reference could not be resolved: "' + reference + '" has no such field')
        return self.items[reference]


def fake_factory(items):
    async def factory():
        return FakeOnePassword(items)

    return factory


def test_onepassword_reads_a_field_per_secret_from_one_item():
    items = {
        "op://Starter/crm/DROPCOWBOY_API_KEY": API_KEY,
        "op://Starter/crm/DROPCOWBOY_API_SECRET": API_SECRET,
        "op://Starter/crm/UNRELATED_SECRET": "ignored",
    }
    provider = onepassword.OnePasswordSecrets(
        {"OP_SERVICE_ACCOUNT_TOKEN": "t", "OP_VAULT": "Starter", "OP_ITEM": "crm"}, fake_factory(items)
    )
    assert provider.load(NAMES) == {"DROPCOWBOY_API_KEY": API_KEY, "DROPCOWBOY_API_SECRET": API_SECRET}


def test_onepassword_reads_one_item_per_secret_without_op_item():
    items = {"op://Starter/DROPCOWBOY_WEBHOOK_SECRET/credential": WEBHOOK_SECRET}
    provider = onepassword.OnePasswordSecrets(
        {"OP_SERVICE_ACCOUNT_TOKEN": "t", "OP_VAULT": "Starter"}, fake_factory(items)
    )
    assert provider.load(NAMES) == {"DROPCOWBOY_WEBHOOK_SECRET": WEBHOOK_SECRET}


def test_onepassword_refresh_reads_the_same_names_again():
    items = {"op://Starter/crm/DROPCOWBOY_WEBHOOK_SECRET": "one"}
    provider = onepassword.OnePasswordSecrets(
        {"OP_SERVICE_ACCOUNT_TOKEN": "t", "OP_VAULT": "Starter", "OP_ITEM": "crm"}, fake_factory(items)
    )
    provider.load(["DROPCOWBOY_WEBHOOK_SECRET"])
    items["op://Starter/crm/DROPCOWBOY_WEBHOOK_SECRET"] = "two"
    assert provider.refresh() == {"DROPCOWBOY_WEBHOOK_SECRET": "two"}


def test_onepassword_fails_when_nothing_at_all_can_be_read_and_names_the_vault():
    provider = onepassword.OnePasswordSecrets(
        {"OP_SERVICE_ACCOUNT_TOKEN": "tok-secret", "OP_VAULT": "Wrong", "OP_ITEM": "crm"}, fake_factory({})
    )
    with pytest.raises(RuntimeError, match='vault "Wrong", item "crm"') as caught:
        provider.load(NAMES)
    assert "tok-secret" not in str(caught.value)


def test_onepassword_leaves_out_a_name_it_does_not_have():
    provider = onepassword.OnePasswordSecrets(
        {"OP_SERVICE_ACCOUNT_TOKEN": "t", "OP_VAULT": "Starter", "OP_ITEM": "crm"},
        fake_factory({"op://Starter/crm/DROPCOWBOY_API_KEY": API_KEY}),
    )
    assert provider.load(["DROPCOWBOY_API_KEY", "STARTER_CRM_CHECK_ABSENT_NAME"]) == {"DROPCOWBOY_API_KEY": API_KEY}


# ---- Boot -----------------------------------------------------------------

SERVER = {
    "DC_AUTH_MODE": "server",
    "DROPCOWBOY_SITE_ID": SITE_ID,
    "STARTER_CRM_USER_ID": USER_ID,
}


def test_boot_takes_the_secrets_from_the_manager_and_redacts_them_and_the_credential(stubs, tmp_path):
    stub, env = doppler_setup(stubs)
    booted = bootstrap({**SERVER, **env}, tmp_path)
    assert booted.problems == []
    assert booted.config.api_key == API_KEY
    assert booted.config.webhook_secrets == [WEBHOOK_SECRET]
    assert env["DOPPLER_TOKEN"] in booted.config.known_secrets, (
        "the bootstrap credential is redacted from the first log line"
    )
    assert API_KEY in booted.config.known_secrets


def test_boot_failure_names_the_provider_and_never_the_credential(stubs, tmp_path):
    stub, env = doppler_setup(stubs)
    wrong = "dp.st.wrong-" + str(uuid.uuid4())
    booted = bootstrap({**SERVER, **env, "DOPPLER_TOKEN": wrong}, tmp_path)
    assert [item.code for item in booted.problems] == ["secret_load_failed"]
    text = booted.problems[0].message + booted.problems[0].fix
    assert "doppler" in text and "HTTP 401" in text
    assert wrong not in text
