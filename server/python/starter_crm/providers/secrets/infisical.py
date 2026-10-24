"""The ``infisical`` secrets provider: reads one environment of an Infisical project.

Where it sits: ``DC_SECRETS=infisical``. It works against Infisical Cloud or
your own Infisical (``INFISICAL_URL``). The provider signs in with a machine
identity's client id and secret (universal auth), receives a short-lived access
token, reads the secrets of one project environment and folder, and keeps only
the names the starter asks for. It signs in again when the token expires, or
when Infisical answers 401 to a call. REST over ``urllib``; there is no SDK.

Client id and secret are the bootstrap credential and come from the host's
environment. Everything else comes from Infisical.

CONTRACT.md: "Providers" (secrets).
Env: INFISICAL_CLIENT_ID, INFISICAL_CLIENT_SECRET, INFISICAL_PROJECT_ID (all required),
  INFISICAL_ENVIRONMENT (default prod), INFISICAL_SECRET_PATH (default /),
  INFISICAL_URL (default https://app.infisical.com).
What a customer changes: nothing.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from urllib.parse import urlencode

from ...problems import BootProblem, problem
from ._http import ManagerError, pick, request_json, validate_base_url

name = "infisical"
config_keys = [
    "INFISICAL_CLIENT_ID",
    "INFISICAL_CLIENT_SECRET",
    "INFISICAL_PROJECT_ID",
    "INFISICAL_ENVIRONMENT",
    "INFISICAL_SECRET_PATH",
    "INFISICAL_URL",
]

DEFAULT_URL = "https://app.infisical.com"
# Sign in again this many seconds before the token's stated expiry, so a call never carries a token about to lapse.
EXPIRY_MARGIN_SECONDS = 30


def validate(env) -> list[BootProblem]:
    """Checks the identity, the project and the address.

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    problems: list[BootProblem] = []

    def is_set(key: str) -> bool:
        return bool((env.get(key) or "").strip())

    for key, fix in (
        (
            "INFISICAL_CLIENT_ID",
            "Create a machine identity with universal auth and set INFISICAL_CLIENT_ID to its client id.",
        ),
        (
            "INFISICAL_CLIENT_SECRET",
            "Set INFISICAL_CLIENT_SECRET to a client secret of that machine identity, in the host's environment.",
        ),
        ("INFISICAL_PROJECT_ID", "Set INFISICAL_PROJECT_ID to the id of the project that holds the secrets."),
    ):
        if not is_set(key):
            problems.append(problem("missing_infisical_setting", "DC_SECRETS=infisical needs " + key + ".", fix))
    if is_set("INFISICAL_URL"):
        bad = validate_base_url("INFISICAL_URL", env["INFISICAL_URL"].strip())
        if bad:
            problems.append(bad)
    return problems


class InfisicalSecrets:
    """Reads one Infisical project environment on demand."""

    def __init__(self, env, now: Callable[[], float] = time.monotonic):
        """Creates the provider.

        Args:
            env: The merged environment holding the INFISICAL_* settings.
            now: Clock in seconds, replaceable in tests.
        """
        self._client_id = env["INFISICAL_CLIENT_ID"].strip()
        self._client_secret = env["INFISICAL_CLIENT_SECRET"].strip()
        self._project_id = env["INFISICAL_PROJECT_ID"].strip()
        self._environment = (env.get("INFISICAL_ENVIRONMENT") or "").strip() or "prod"
        self._path = (env.get("INFISICAL_SECRET_PATH") or "").strip() or "/"
        self._base = ((env.get("INFISICAL_URL") or "").strip() or DEFAULT_URL).rstrip("/")
        self._now = now
        self._last_names: list[str] = []
        self._token: str | None = None
        self._expires_at = 0.0

    def load(self, names: list[str]) -> dict:
        """Signs in if needed, reads the environment and keeps the named secrets.

        Args:
            names: The secret names to look for.

        Returns:
            ``{NAME: value}`` for each name Infisical has.
        """
        self._last_names = list(names)
        return self._read(self._last_names)

    def refresh(self) -> dict:
        """Reads again the names the last ``load`` asked for.

        Returns:
            ``{NAME: value}`` as of now.
        """
        return self._read(self._last_names)

    def _sign_in(self) -> None:
        body = request_json(
            "Infisical",
            self._base + "/api/v1/auth/universal-auth/login",
            method="POST",
            body={"clientId": self._client_id, "clientSecret": self._client_secret},
        )
        token = body.get("accessToken") if isinstance(body, dict) else None
        if not isinstance(token, str) or not token:
            raise ManagerError("Infisical sign-in did not return an access token")
        expires_in = body.get("expiresIn")
        seconds = expires_in if isinstance(expires_in, int | float) and not isinstance(expires_in, bool) else 0
        self._token = token
        self._expires_at = self._now() + seconds - EXPIRY_MARGIN_SECONDS

    def _fetch(self):
        query = urlencode(
            {
                "workspaceId": self._project_id,
                "environment": self._environment,
                "secretPath": self._path,
                "expandSecretReferences": "true",
            }
        )
        return request_json(
            "Infisical",
            self._base + "/api/v3/secrets/raw?" + query,
            headers={"Authorization": "Bearer " + str(self._token)},
        )

    def _read(self, names: list[str]) -> dict:
        if self._token is None or self._now() >= self._expires_at:
            self._sign_in()
        try:
            body = self._fetch()
        except ManagerError as err:
            # The token can be revoked before it expires; one fresh sign-in, then give up.
            if err.status != 401:
                raise
            self._sign_in()
            body = self._fetch()
        everything = {}
        items = body.get("secrets") if isinstance(body, dict) else None
        for item in items if isinstance(items, list) else []:
            if isinstance(item, dict) and isinstance(item.get("secretKey"), str):
                everything[item["secretKey"]] = item.get("secretValue")
        return pick(everything, names)


def create(ctx) -> InfisicalSecrets:
    """Creates the provider.

    Args:
        ctx: The provider context; ``ctx.env`` holds the INFISICAL_* settings.

    Returns:
        The instance.
    """
    return InfisicalSecrets(ctx.env)
