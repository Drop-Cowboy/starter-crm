"""The ``doppler`` secrets provider: reads one Doppler config with a service token.

Where it sits: ``DC_SECRETS=doppler``. A Doppler service token belongs to one
project and one config (for example ``starter-crm`` / ``prd``), so the token
alone says what to read. The provider downloads that config's secrets and keeps
only the names the starter asks for. It uses Doppler's REST API; there is no SDK
to install.

The token is the one credential that must come from the host's environment
(``DOPPLER_TOKEN``), since nothing can be loaded without it. Everything else
comes from Doppler, and a rotated value is picked up every
``DC_SECRETS_REFRESH_SECONDS`` without a restart.

CONTRACT.md: "Providers" (secrets).
Env: DOPPLER_TOKEN (required), DOPPLER_API_URL (default https://api.doppler.com).
What a customer changes: nothing.
"""

from __future__ import annotations

from ...problems import BootProblem, problem
from ._http import pick, request_json, validate_base_url

name = "doppler"
config_keys = ["DOPPLER_TOKEN", "DOPPLER_API_URL"]

DEFAULT_URL = "https://api.doppler.com"


def validate(env) -> list[BootProblem]:
    """Checks the token is set and the API address is safe.

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    problems: list[BootProblem] = []
    if not (env.get("DOPPLER_TOKEN") or "").strip():
        problems.append(
            problem(
                "missing_doppler_token",
                "DC_SECRETS=doppler needs DOPPLER_TOKEN.",
                "Create a service token for one Doppler config and put it in the host's environment under that name.",
            )
        )
    url = (env.get("DOPPLER_API_URL") or "").strip()
    if url:
        bad = validate_base_url("DOPPLER_API_URL", url)
        if bad:
            problems.append(bad)
    return problems


class DopplerSecrets:
    """Reads one Doppler config on demand."""

    def __init__(self, token: str, base_url: str):
        """Creates the provider.

        Args:
            token: The service token.
            base_url: The API address, without a trailing slash.
        """
        self._token = token
        self._base = base_url
        self._last_names: list[str] = []

    def load(self, names: list[str]) -> dict:
        """Reads the config and keeps the named secrets.

        Args:
            names: The secret names to look for.

        Returns:
            ``{NAME: value}`` for each name Doppler has.
        """
        self._last_names = list(names)
        return self._read(self._last_names)

    def refresh(self) -> dict:
        """Reads again the names the last ``load`` asked for.

        Returns:
            ``{NAME: value}`` as of now.
        """
        return self._read(self._last_names)

    def _read(self, names: list[str]) -> dict:
        body = request_json(
            "Doppler",
            self._base + "/v3/configs/config/secrets/download?format=json",
            headers={"Authorization": "Bearer " + self._token},
        )
        return pick(body, names)


def create(ctx) -> DopplerSecrets:
    """Creates the provider.

    Args:
        ctx: The provider context; ``ctx.env`` holds ``DOPPLER_TOKEN`` and optionally ``DOPPLER_API_URL``.

    Returns:
        The instance.
    """
    base = (ctx.env.get("DOPPLER_API_URL") or "").strip() or DEFAULT_URL
    return DopplerSecrets(ctx.env["DOPPLER_TOKEN"].strip(), base.rstrip("/"))
