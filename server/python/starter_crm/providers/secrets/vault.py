"""The ``vault`` secrets provider: HashiCorp Vault or OpenBao, KV version 2.

Where it sits: ``DC_SECRETS=vault``. One KV v2 secret (a path under a mount)
holds one field per starter secret: ``DROPCOWBOY_API_KEY``, and so on. The
provider reads that secret's current version and keeps only the names the
starter asks for. REST over ``urllib``; there is no SDK, and OpenBao answers the
same API, so one provider serves both.

Authentication is one of:

- a token (``VAULT_TOKEN``), which the provider uses as is, or
- AppRole (``VAULT_ROLE_ID`` and ``VAULT_SECRET_ID``), which the provider logs
  in with, then logs in again before the token's lease runs out or when Vault
  answers 403 to a call.

The token, or the role id and secret id, is the bootstrap credential and comes
from the host's environment.

CONTRACT.md: "Providers" (secrets).
Env: VAULT_ADDR and VAULT_PATH (required); VAULT_TOKEN, or VAULT_ROLE_ID with
  VAULT_SECRET_ID; VAULT_MOUNT (default secret), VAULT_APPROLE_MOUNT (default
  approle), VAULT_NAMESPACE (Vault Enterprise and HCP).
What a customer changes: nothing.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from urllib.parse import quote

from ...problems import BootProblem, problem
from ._http import ManagerError, pick, request_json, validate_base_url

name = "vault"
config_keys = [
    "VAULT_ADDR",
    "VAULT_TOKEN",
    "VAULT_ROLE_ID",
    "VAULT_SECRET_ID",
    "VAULT_PATH",
    "VAULT_MOUNT",
    "VAULT_APPROLE_MOUNT",
    "VAULT_NAMESPACE",
]

# Log in again when this share of an AppRole token's lease has passed.
LEASE_SHARE = 0.8


def validate(env) -> list[BootProblem]:
    """Checks the address, the secret's path and exactly one way to authenticate.

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    problems: list[BootProblem] = []

    def is_set(key: str) -> bool:
        return bool((env.get(key) or "").strip())

    if not is_set("VAULT_ADDR"):
        problems.append(
            problem(
                "missing_vault_setting",
                "DC_SECRETS=vault needs VAULT_ADDR.",
                "Set VAULT_ADDR to your Vault or OpenBao address, for example https://vault.example.com:8200.",
            )
        )
    else:
        bad = validate_base_url("VAULT_ADDR", env["VAULT_ADDR"].strip())
        if bad:
            problems.append(bad)
    if not is_set("VAULT_PATH"):
        problems.append(
            problem(
                "missing_vault_setting",
                "DC_SECRETS=vault needs VAULT_PATH.",
                "Set VAULT_PATH to the KV v2 secret that holds the starter's secrets, for example starter-crm.",
            )
        )
    elif ".." in env["VAULT_PATH"].split("/"):
        problems.append(
            problem(
                "invalid_vault_path",
                'VAULT_PATH must not contain "..".',
                "Set VAULT_PATH to a plain path such as starter-crm or apps/starter-crm.",
            )
        )
    token = is_set("VAULT_TOKEN")
    role = is_set("VAULT_ROLE_ID") or is_set("VAULT_SECRET_ID")
    if token and role:
        problems.append(
            problem(
                "invalid_vault_auth",
                "VAULT_TOKEN and VAULT_ROLE_ID / VAULT_SECRET_ID are both set.",
                "Use one: a token, or AppRole. Remove the other.",
            )
        )
    elif not token and not role:
        problems.append(
            problem(
                "missing_vault_setting",
                "DC_SECRETS=vault needs VAULT_TOKEN, or VAULT_ROLE_ID with VAULT_SECRET_ID.",
                "Set VAULT_TOKEN, or set both VAULT_ROLE_ID and VAULT_SECRET_ID for AppRole.",
            )
        )
    elif role and not (is_set("VAULT_ROLE_ID") and is_set("VAULT_SECRET_ID")):
        problems.append(
            problem(
                "missing_vault_setting",
                "AppRole needs both VAULT_ROLE_ID and VAULT_SECRET_ID.",
                "Set both, or use VAULT_TOKEN instead.",
            )
        )
    return problems


def _segments(value: str) -> str:
    """Turns a mount or path setting into URL path segments, each encoded, with no empty ones.

    Args:
        value: Such as ``apps/starter-crm/``.

    Returns:
        Such as ``apps/starter-crm``.
    """
    return "/".join(quote(part, safe="") for part in value.split("/") if part)


class VaultSecrets:
    """Reads one KV v2 secret on demand."""

    def __init__(self, env, now: Callable[[], float] = time.monotonic):
        """Creates the provider.

        Args:
            env: The merged environment holding the VAULT_* settings.
            now: Clock in seconds, replaceable in tests.
        """
        self._base = env["VAULT_ADDR"].strip().rstrip("/")
        self._mount = _segments((env.get("VAULT_MOUNT") or "").strip() or "secret")
        self._approle_mount = _segments((env.get("VAULT_APPROLE_MOUNT") or "").strip() or "approle")
        self._path = _segments(env["VAULT_PATH"].strip())
        self._namespace = (env.get("VAULT_NAMESPACE") or "").strip()
        self._role_id = (env.get("VAULT_ROLE_ID") or "").strip()
        self._secret_id = (env.get("VAULT_SECRET_ID") or "").strip()
        self._static_token = (env.get("VAULT_TOKEN") or "").strip()
        self._now = now
        self._last_names: list[str] = []
        self._token: str | None = self._static_token or None
        self._expires_at = float("inf") if self._static_token else 0.0

    def load(self, names: list[str]) -> dict:
        """Logs in if needed, reads the secret and keeps the named fields.

        Args:
            names: The secret names to look for.

        Returns:
            ``{NAME: value}`` for each field Vault has.
        """
        self._last_names = list(names)
        return self._read(self._last_names)

    def refresh(self) -> dict:
        """Reads again the names the last ``load`` asked for.

        Returns:
            ``{NAME: value}`` as of now.
        """
        return self._read(self._last_names)

    def _namespace_header(self) -> dict[str, str]:
        return {"X-Vault-Namespace": self._namespace} if self._namespace else {}

    def _login(self) -> None:
        body = request_json(
            "Vault",
            self._base + "/v1/auth/" + self._approle_mount + "/login",
            method="POST",
            headers=self._namespace_header(),
            body={"role_id": self._role_id, "secret_id": self._secret_id},
        )
        auth = body.get("auth") if isinstance(body, dict) else None
        token = auth.get("client_token") if isinstance(auth, dict) else None
        if not isinstance(token, str) or not token:
            raise ManagerError("Vault AppRole login did not return a token")
        lease = auth.get("lease_duration")
        seconds = lease if isinstance(lease, int | float) and not isinstance(lease, bool) and lease > 0 else 0
        self._token = token
        self._expires_at = self._now() + seconds * LEASE_SHARE if seconds > 0 else self._now()

    def _fetch(self):
        try:
            return request_json(
                "Vault",
                self._base + "/v1/" + self._mount + "/data/" + self._path,
                headers={"X-Vault-Token": str(self._token), **self._namespace_header()},
            )
        except ManagerError as err:
            # Name the mount and path, which are settings and not secrets, so a typo is easy to see.
            if err.status == 404:
                raise ManagerError("Vault has no KV v2 secret at " + self._mount + "/" + self._path) from None
            raise

    def _read(self, names: list[str]) -> dict:
        if self._token is None or self._now() >= self._expires_at:
            self._login()
        try:
            body = self._fetch()
        except ManagerError as err:
            # An AppRole token can be revoked early; one fresh login, then give up.
            # A static token cannot be renewed here.
            if err.status != 403 or self._static_token:
                raise
            self._login()
            body = self._fetch()
        outer = body.get("data") if isinstance(body, dict) else None
        inner = outer.get("data") if isinstance(outer, dict) else None
        return pick(inner, names)


def create(ctx) -> VaultSecrets:
    """Creates the provider.

    Args:
        ctx: The provider context; ``ctx.env`` holds the VAULT_* settings.

    Returns:
        The instance.
    """
    return VaultSecrets(ctx.env)
