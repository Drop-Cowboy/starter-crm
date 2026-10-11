"""Reads and validates the environment. See "Configuration" in ../CONTRACT.md."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

MODES = ("login", "server", "mcp-session")
DEFAULT_API_BASE = "https://api-v2.dropcowboy.com"

# [0-9], not \d: in Python \d also matches non-ASCII digits such as "٣".
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
WHOLE_NUMBER = re.compile(r"[0-9]+")
HTTP_URL = re.compile(r"https?://[^/]+")

SITE_ID_NOT_UUID = (
    "DROPCOWBOY_SITE_ID must be a UUID such as 3f8a2c1e-9b4d-4e7a-8c2f-1d5e6a7b8c9d "
    '(generate one with `python3 -c "import uuid; print(uuid.uuid4())"`). '
    "Drop Cowboy rejects any other site_id with 400 invalid_site_id."
)

# python/starter_crm/config.py -> the starter folder, which holds .env.example.
DEFAULT_ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Auth0Settings:
    domain: str
    client_id: str | None
    audience: str


@dataclass(frozen=True)
class Config:
    mode: str
    root: Path
    host: str
    port: int
    api_base: str
    timeout_ms: int
    api_key: str | None
    api_secret: str | None
    site_id: str | None
    # One secret per webhook, so a list.
    webhook_secrets: tuple[str, ...]
    starter_user_id: str | None
    cdn_version: str | None
    auth0: Auth0Settings


def starter_root(env: Mapping[str, str]) -> Path:
    """The folder holding .env, .dropcowboy/ and the front-ends.

    STARTER_CRM_ROOT exists so tests can point the server at a temporary
    folder. Call this before loading .env, so the file cannot set it.
    """
    override = _read(env, "STARTER_CRM_ROOT")
    return Path(override) if override else DEFAULT_ROOT


def load_config(env: Mapping[str, str], root: Path | None = None) -> tuple[Config, list[str]]:
    """Returns ``(config, problems)``.

    A non-empty ``problems`` list means the server must not start;
    ``__main__`` prints the problems and exits. No problem message ever
    contains a secret value.
    """
    if root is None:
        root = starter_root(env)
    problems: list[str] = []

    mode = _read(env, "DC_AUTH_MODE") or "server"
    if mode not in MODES:
        problems.append("DC_AUTH_MODE must be one of " + ", ".join(MODES) + ' (got "' + mode + '").')

    api_base = (_read(env, "DROPCOWBOY_API_BASE") or DEFAULT_API_BASE).rstrip("/")
    if not HTTP_URL.match(api_base):
        problems.append("DROPCOWBOY_API_BASE must be an http(s) URL.")

    port = _whole_number(_read(env, "PORT") or "8080")
    if port is None or port > 65535:
        problems.append("PORT must be a whole number between 0 and 65535.")

    timeout_ms = _whole_number(_read(env, "DROPCOWBOY_TIMEOUT_MS") or "10000")
    if timeout_ms is None or timeout_ms <= 0:
        problems.append("DROPCOWBOY_TIMEOUT_MS must be a positive whole number of milliseconds.")

    webhook_secrets = []
    for secret in (_read(env, "DROPCOWBOY_WEBHOOK_SECRET") or "").split(","):
        if secret.strip():
            webhook_secrets.append(secret.strip())

    config = Config(
        mode=mode,
        root=root,
        host=_read(env, "HOST") or "127.0.0.1",
        port=port if port is not None else 0,
        api_base=api_base,
        timeout_ms=timeout_ms if timeout_ms is not None else 0,
        api_key=_read(env, "DROPCOWBOY_API_KEY"),
        api_secret=_read(env, "DROPCOWBOY_API_SECRET"),
        site_id=_read(env, "DROPCOWBOY_SITE_ID"),
        webhook_secrets=tuple(webhook_secrets),
        starter_user_id=_read(env, "STARTER_CRM_USER_ID"),
        cdn_version=_read(env, "DC_CDN_VERSION"),
        auth0=Auth0Settings(
            domain=_read(env, "AUTH0_DOMAIN") or "login.dropcowboy.com",
            client_id=_read(env, "AUTH0_CLIENT_ID"),
            audience=_read(env, "AUTH0_AUDIENCE") or DEFAULT_API_BASE,
        ),
    )

    # Checked in every mode: login mode hands site_id to the browser and
    # mcp-session falls back to it, and Drop Cowboy answers 400 invalid_site_id.
    if config.site_id and not UUID.fullmatch(config.site_id):
        problems.append(SITE_ID_NOT_UUID)

    # Both modes that mint send it with every mint.
    if mode in ("server", "login") and not config.site_id:
        problems.append("DROPCOWBOY_SITE_ID is required when DC_AUTH_MODE=" + mode + ".")

    if mode == "server":
        problems.extend(_server_mode_problems(config))

    return config, problems


def secret_values(config: Config) -> list[str]:
    """The values that must never appear in a log line or a response."""
    values = [config.api_key, config.api_secret] + list(config.webhook_secrets)
    return [value for value in values if value]


def _server_mode_problems(config: Config) -> list[str]:
    problems = []
    if not config.api_key:
        problems.append("DROPCOWBOY_API_KEY is required when DC_AUTH_MODE=server.")
    if not config.api_secret:
        problems.append("DROPCOWBOY_API_SECRET is required when DC_AUTH_MODE=server.")
    if not config.starter_user_id:
        problems.append("STARTER_CRM_USER_ID is required when DC_AUTH_MODE=server (it stands in for your signed-in user).")
    elif not UUID.fullmatch(config.starter_user_id):
        problems.append("STARTER_CRM_USER_ID must be a UUID.")
    return problems


def _read(env: Mapping[str, str], name: str) -> str | None:
    """The trimmed value of ``name``, or None when it is unset or blank."""
    value = env.get(name)
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _whole_number(text: str) -> int | None:
    return int(text) if WHOLE_NUMBER.fullmatch(text) else None
