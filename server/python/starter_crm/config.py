"""Reads and validates the environment. See "Configuration" in ../CONTRACT.md.

Where it sits: ``__main__`` and the conformance harness call ``load_config()``
before ``create_app()``. Nothing that talks to Drop Cowboy runs until
``problems`` is empty.

Customers change values in ``.env`` (see ``.env.example``); they should not
need to edit this file.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlparse

from .problems import BootProblem, problem
from .redis_util import redis_url

MODES = ("login", "server", "mcp-session")
# The built-in identities; a relative path (``./my_identity.py``) names your own.
IDENTITIES = ("dev", "passcode", "oidc")
CSP_MODES = ("report-only", "enforce", "off")
LOG_FORMATS = ("pretty", "json")
# The built-in DC_SECRETS values; providers/__init__.py registers a module for each of them.
SECRETS_PROVIDERS = ("env", "file", "doppler", "infisical", "1password", "vault", "aws-secrets-manager", "aws-ssm")
# The longest a secrets refresh interval may be: one day.
MAX_REFRESH_SECONDS = 86400
# The built-in DC_STORE, DC_FANOUT and DC_WEBHOOKS values; providers/__init__.py registers a module for each.
STORES = ("memory", "sqlite", "postgres", "redis", "dynamodb")
FANOUTS = ("local", "redis", "postgres", "poll")
WEBHOOK_MODES = ("store", "bullmq", "inline", "sqs", "vercel-queue", "netlify-async", "qstash")
# Webhook modes whose queue calls back into this server (or a consumer route of it), so they need no worker process.
PUSH_MODES = ("vercel-queue", "netlify-async", "qstash")
# Webhook modes that need a worker process polling a queue.
WORKER_MODES = ("bullmq", "sqs")
# Longest an SSE stream may run on Vercel by default: the function limit on Hobby (300 s) less a margin to reconnect.
VERCEL_STREAM_SECONDS = 290
# The same on Netlify. Netlify documents 60 s for a streaming function, but a Free-plan site measured in
# October 2026 cut every stream at 30 s, so this stays under that.
NETLIFY_STREAM_SECONDS = 25
# How often an idle SSE stream sends ": keepalive". CONTRACT.md asks for at least every 30 s.
KEEPALIVE_SECONDS = 25
# The same on Netlify, which drops a streamed write that follows about 10 s of silence and ends the stream.
NETLIFY_KEEPALIVE_SECONDS = 5
# The built-in DC_DATA values (module documents). Redis is not one: module data needs filtered queries and backups.
DATA_PROVIDERS = ("memory", "sqlite", "postgres", "dynamodb")
ENVIRONMENTS = ("development", "production")
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
    """The public Auth0 values the browser needs in ``login`` mode."""

    domain: str
    client_id: str | None
    audience: str


@dataclass(frozen=True)
class OidcSettings:
    """The ``DC_OIDC_*`` settings."""

    issuer: str | None
    audience: str | None
    jwks_url: str | None


@dataclass(frozen=True)
class SecretsSettings:
    """The ``DC_SECRETS*`` settings."""

    provider: str
    dir: str | None
    refresh_seconds: int


@dataclass
class EventSettings:
    """The ``DC_STORE``, ``DC_FANOUT``, ``DC_WEBHOOKS`` and related settings; ``config.events`` in Node."""

    store: str
    fanout: str
    webhooks: str
    sqlite_path: str
    retention_hours: int
    max_stream_seconds: int
    keepalive_seconds: int
    fanout_poll_ms: int
    outbox_poll_ms: int
    max_attempts: int
    handler_budget_ms: int
    handlers_path: str | None
    worker_in_process: bool


@dataclass
class DataSettings:
    """Where module documents are kept (``DC_DATA``).

    Attributes:
        provider: The built-in name (``memory``, ``sqlite``, ``postgres``, ``dynamodb``) or the ``./path`` of your own.
    """

    provider: str


@dataclass
class Config:
    """Everything the server reads from the environment, validated once at boot.

    Not frozen, on purpose: a secrets provider that can refresh swaps
    ``api_key``, ``api_secret`` and ``webhook_secrets`` while the server runs
    (``secrets_refresh.py``), and ``known_secrets`` grows as providers load
    values. Nothing else should assign to it. Mirrors the Node ``config``
    object field for field.
    """

    mode: str
    identity: str
    identity_kind: str
    passcode: str | None
    oidc: OidcSettings
    secrets: SecretsSettings
    rate_limit: str
    events: EventSettings
    data: DataSettings
    # Passwords inside DC_DATABASE_URL and DC_REDIS_URL, so the logger redacts them wherever they might surface.
    url_secrets: list[str]
    # The serverless platform (``vercel`` or ``netlify``) the process runs on, or None on a long-running host.
    platform: str | None
    # Facts worth telling the operator at boot that are not problems, such as a fan-out changed for the host.
    notices: list[str]
    token_cache: bool
    log_format: str
    log_requests: bool
    log_provider: str
    observer: str | None
    csp: str
    cors_origins: tuple[str, ...]
    known_secrets: set
    env: str
    root: Path
    host: str
    port: int
    api_base: str
    timeout_ms: int
    shutdown_grace_seconds: int
    trust_proxy: int
    public_url: str | None
    api_key: str | None
    api_secret: str | None
    site_id: str | None
    # One secret per webhook, so a list.
    webhook_secrets: list[str]
    starter_user_id: str | None
    cdn_version: str | None
    auth0: Auth0Settings


def detect_platform(env: Mapping[str, str]) -> str | None:
    """The serverless platform the process runs on, from the variables each host sets itself.

    Serverless functions start and stop at the host's choice and freeze between requests, so a few settings
    that are fine on one long-running machine cannot work there (see the guards in ``_parse_events``).

    Args:
        env: The process environment.

    Returns:
        ``vercel``, ``netlify``, or None on an ordinary long-running host.
    """
    if _read(env, "VERCEL"):
        return "vercel"
    if _read(env, "NETLIFY"):
        return "netlify"
    return None


def starter_root(env: Mapping[str, str]) -> Path:
    """The folder holding .env, .dropcowboy/ and the front-ends.

    STARTER_CRM_ROOT exists so tests can point the server at a temporary
    folder. Call this before loading .env, so the file cannot set it.
    """
    override = _read(env, "STARTER_CRM_ROOT")
    return Path(override) if override else DEFAULT_ROOT


def load_config(env: Mapping[str, str], root: Path | None = None) -> tuple[Config, list[BootProblem]]:
    """Returns ``(config, problems)``.

    A non-empty ``problems`` list means the server must not start;
    ``__main__`` prints the problems and exits. No problem message ever
    contains a secret value.

    Args:
        env: Process environment (or a test stand-in).
        root: Starter root; defaults to ``starter_root(env)``.

    Returns:
        A Config dataclass and a list of BootProblem (empty when valid).
    """
    if root is None:
        root = starter_root(env)
    problems: list[BootProblem] = []

    if _read(env, "SAMPLE_USER_ID"):
        problems.append(
            problem(
                "renamed_env",
                "SAMPLE_USER_ID was renamed to STARTER_CRM_USER_ID.",
                "Rename SAMPLE_USER_ID to STARTER_CRM_USER_ID in your .env (or unset it).",
            )
        )
    if _read(env, "SAMPLE_CRM_ROOT"):
        problems.append(
            problem(
                "renamed_env",
                "SAMPLE_CRM_ROOT was renamed to STARTER_CRM_ROOT.",
                "Rename SAMPLE_CRM_ROOT to STARTER_CRM_ROOT in your environment (or unset it).",
            )
        )

    mode = _read(env, "DC_AUTH_MODE") or "server"
    if mode not in MODES:
        problems.append(
            problem(
                "invalid_auth_mode",
                "DC_AUTH_MODE must be one of " + ", ".join(MODES) + ' (got "' + mode + '").',
                "Set DC_AUTH_MODE to server, login, or mcp-session.",
            )
        )

    # A function host is public by definition, so there the default is production.
    dc_env = (_read(env, "DC_ENV") or ("production" if detect_platform(env) else "development")).lower()
    if dc_env not in ENVIRONMENTS:
        problems.append(
            problem(
                "invalid_env",
                "DC_ENV must be one of " + ", ".join(ENVIRONMENTS) + ' (got "' + dc_env + '").',
                "Set DC_ENV to development or production.",
            )
        )

    # DC_IDENTITY (default: dev): who your app's user is in server mode. The
    # built-ins are dev, passcode and oidc; a ./path is your own provider.
    # Production refuses dev. The provider's own settings (DC_PASSCODE,
    # DC_OIDC_*) are checked by its validate() once its module is loaded.
    identity = _read(env, "DC_IDENTITY") or "dev"
    if identity not in IDENTITIES and not is_provider_path(identity):
        problems.append(
            problem(
                "invalid_identity",
                "DC_IDENTITY must be one of "
                + ", ".join(IDENTITIES)
                + ", or a relative path to your own provider such as ./my_identity.py "
                + '(got "'
                + identity
                + '").',
                "Set DC_IDENTITY to dev, passcode or oidc, or point it at your own provider file.",
            )
        )
    elif mode != "server" and mode in MODES and identity != "dev":
        # Server mode is the only one that uses an identity.
        problems.append(
            problem(
                "identity_requires_server_mode",
                "DC_IDENTITY=" + identity + " only applies when DC_AUTH_MODE=server (this is " + mode + ").",
                "Unset DC_IDENTITY, or set DC_AUTH_MODE=server.",
            )
        )

    if dc_env == "production" and identity == "dev":
        problems.append(
            problem(
                "production_dev_identity",
                "DC_ENV=production refuses DC_IDENTITY=dev because the placeholder "
                "require_user() would hand a dialer-scoped token to anyone.",
                "For production, set DC_IDENTITY to passcode, oidc or your own provider, "
                "or run with DC_ENV=development locally.",
            )
        )

    if dc_env == "production" and mode == "mcp-session":
        problems.append(
            problem(
                "production_mcp_session",
                "DC_ENV=production refuses DC_AUTH_MODE=mcp-session (dev-only file handoff).",
                "Set DC_AUTH_MODE=server (or login) for production.",
            )
        )

    api_base = (_read(env, "DROPCOWBOY_API_BASE") or DEFAULT_API_BASE).rstrip("/")
    if not HTTP_URL.match(api_base):
        problems.append(
            problem(
                "invalid_api_base",
                "DROPCOWBOY_API_BASE must be an http(s) URL.",
                "Set DROPCOWBOY_API_BASE to an https URL such as https://api-v2.dropcowboy.com.",
            )
        )

    port = _whole_number(_read(env, "PORT") or "8080")
    if port is None or port > 65535:
        problems.append(
            problem(
                "invalid_port",
                "PORT must be a whole number between 0 and 65535.",
                "Set PORT to a free port, for example 8080.",
            )
        )

    timeout_ms = _whole_number(_read(env, "DROPCOWBOY_TIMEOUT_MS") or "10000")
    if timeout_ms is None or timeout_ms <= 0:
        problems.append(
            problem(
                "invalid_timeout",
                "DROPCOWBOY_TIMEOUT_MS must be a positive whole number of milliseconds.",
                "Set DROPCOWBOY_TIMEOUT_MS to 10000, or another positive integer.",
            )
        )

    shutdown_grace = _whole_number(_read(env, "DC_SHUTDOWN_GRACE_SECONDS") or "10")
    if shutdown_grace is None or shutdown_grace < 1 or shutdown_grace > 300:
        problems.append(
            problem(
                "invalid_shutdown_grace",
                "DC_SHUTDOWN_GRACE_SECONDS must be a whole number between 1 and 300.",
                "Set DC_SHUTDOWN_GRACE_SECONDS to 10, or another value from 1 to 300.",
            )
        )

    # On Vercel the platform's proxy is exactly one hop and overwrites X-Forwarded-For. Netlify keeps the client's
    # X-Forwarded-For and appends its own hop, so there the entry passes the connecting address and nothing is trusted.
    trust_raw = _read(env, "DC_TRUST_PROXY") or ("1" if detect_platform(env) == "vercel" else "0")
    trust_proxy = _whole_number(trust_raw)
    if trust_proxy is None or trust_proxy > 32:
        problems.append(
            problem(
                "invalid_trust_proxy",
                'DC_TRUST_PROXY must be a whole number between 0 and 32 (got "' + trust_raw + '").',
                "Set DC_TRUST_PROXY to 0 locally, or to 1 behind a single reverse proxy.",
            )
        )

    public_url = _read(env, "DC_PUBLIC_URL")
    if public_url:
        try:
            parsed = urlparse(public_url.rstrip("/"))
            if parsed.scheme not in ("http", "https") or not parsed.netloc or (parsed.path and parsed.path != "/"):
                raise ValueError("bad public url")
            public_url = parsed.scheme + "://" + parsed.netloc
        except ValueError:
            problems.append(
                problem(
                    "invalid_public_url",
                    "DC_PUBLIC_URL must be an http(s) origin such as https://crm.example.com (no path).",
                    "Set DC_PUBLIC_URL to your public HTTPS origin, or leave it unset locally.",
                )
            )
            public_url = None

    log_format = (_read(env, "DC_LOG_FORMAT") or ("json" if dc_env == "production" else "pretty")).lower()
    if log_format not in LOG_FORMATS:
        problems.append(
            problem(
                "invalid_log_format",
                "DC_LOG_FORMAT must be pretty or json" + ' (got "' + log_format + '").',
                "Set DC_LOG_FORMAT to pretty for a readable console, or json for a log service.",
            )
        )
    log_requests = _on_off(env, "DC_LOG_REQUESTS", dc_env == "production", "invalid_log_requests", problems)

    csp = (_read(env, "DC_CSP") or "report-only").lower()
    if csp not in CSP_MODES:
        problems.append(
            problem(
                "invalid_csp",
                "DC_CSP must be one of " + ", ".join(CSP_MODES) + ' (got "' + csp + '").',
                "Set DC_CSP to report-only while you check what the policy blocks, then enforce.",
            )
        )

    cors_origins = _parse_origins(_read(env, "DC_CORS_ORIGINS"), problems)

    rate_limit = _read(env, "DC_RATE_LIMIT") or ("redis" if redis_url(env) else "memory")
    if rate_limit not in ("memory", "off", "redis") and not is_provider_path(rate_limit):
        problems.append(
            problem(
                "invalid_rate_limit",
                "DC_RATE_LIMIT must be memory, redis, off, or a relative path to your own provider"
                + ' (got "'
                + rate_limit
                + '").',
                "Set DC_RATE_LIMIT to memory, redis (shared across instances, needs DC_REDIS_URL), or off.",
            )
        )
    token_cache = _on_off(env, "DC_TOKEN_CACHE", True, "invalid_token_cache", problems)

    secrets_provider = _read(env, "DC_SECRETS") or "env"
    if secrets_provider not in SECRETS_PROVIDERS and not is_provider_path(secrets_provider):
        problems.append(
            problem(
                "invalid_secrets_provider",
                "DC_SECRETS must be "
                + ", ".join(SECRETS_PROVIDERS)
                + ", or a relative path to your own provider"
                + ' (got "'
                + secrets_provider
                + '").',
                "Set DC_SECRETS to env (the default), another built-in, or point it at your own provider file.",
            )
        )
    refresh_seconds = _whole_number(_read(env, "DC_SECRETS_REFRESH_SECONDS") or "300")
    if refresh_seconds is None or refresh_seconds > MAX_REFRESH_SECONDS:
        problems.append(
            problem(
                "invalid_secrets_refresh",
                "DC_SECRETS_REFRESH_SECONDS must be a whole number from 0 to " + str(MAX_REFRESH_SECONDS) + ".",
                "Set DC_SECRETS_REFRESH_SECONDS to 300, or 0 to read secrets only at boot.",
            )
        )

    log_provider = _read(env, "DC_LOG") or "console"
    if log_provider != "console" and not is_provider_path(log_provider):
        problems.append(
            problem(
                "invalid_log_provider",
                "DC_LOG must be console or a relative path to your own provider" + ' (got "' + log_provider + '").',
                "Set DC_LOG to console, or point it at your own log provider file.",
            )
        )
    observer = _read(env, "DC_OBSERVER")
    if observer and not is_provider_path(observer):
        problems.append(
            problem(
                "invalid_observer",
                "DC_OBSERVER must be a relative path to your own observer" + ' (got "' + observer + '").',
                "Set DC_OBSERVER to a path such as ./my_observer.py, or leave it unset.",
            )
        )

    webhook_secrets = []
    for secret in (_read(env, "DROPCOWBOY_WEBHOOK_SECRET") or "").split(","):
        if secret.strip():
            webhook_secrets.append(secret.strip())

    notices: list[str] = []
    events = _parse_events(env, problems, notices)
    config = Config(
        mode=mode,
        identity=identity,
        identity_kind="dev" if mode != "server" else ("custom" if is_provider_path(identity) else identity),
        passcode=_read(env, "DC_PASSCODE"),
        oidc=OidcSettings(
            issuer=_read(env, "DC_OIDC_ISSUER"),
            audience=_read(env, "DC_OIDC_AUDIENCE"),
            jwks_url=_read(env, "DC_OIDC_JWKS_URL"),
        ),
        secrets=SecretsSettings(
            provider=secrets_provider,
            dir=_read(env, "DC_SECRETS_DIR"),
            refresh_seconds=refresh_seconds if refresh_seconds is not None else 300,
        ),
        rate_limit=rate_limit,
        events=events,
        data=_parse_data(env, mode, events.store, problems),
        url_secrets=_url_passwords(env),
        platform=detect_platform(env),
        notices=notices,
        token_cache=token_cache,
        log_format=log_format,
        log_requests=log_requests,
        log_provider=log_provider,
        observer=observer,
        csp=csp,
        cors_origins=tuple(cors_origins),
        known_secrets=set(),
        env=dc_env,
        root=root,
        host=_read(env, "HOST") or "127.0.0.1",
        port=port if port is not None else 0,
        api_base=api_base,
        timeout_ms=timeout_ms if timeout_ms is not None else 0,
        shutdown_grace_seconds=shutdown_grace if shutdown_grace is not None else 10,
        trust_proxy=trust_proxy if trust_proxy is not None else 0,
        public_url=public_url,
        api_key=_read(env, "DROPCOWBOY_API_KEY"),
        api_secret=_read(env, "DROPCOWBOY_API_SECRET"),
        site_id=_read(env, "DROPCOWBOY_SITE_ID"),
        webhook_secrets=webhook_secrets,
        starter_user_id=_read(env, "STARTER_CRM_USER_ID"),
        cdn_version=_read(env, "DC_CDN_VERSION"),
        auth0=Auth0Settings(
            domain=_read(env, "AUTH0_DOMAIN") or "login.dropcowboy.com",
            client_id=_read(env, "AUTH0_CLIENT_ID"),
            audience=_read(env, "AUTH0_AUDIENCE") or DEFAULT_API_BASE,
        ),
    )

    if config.site_id and not UUID.fullmatch(config.site_id):
        problems.append(
            problem(
                "invalid_site_id",
                SITE_ID_NOT_UUID,
                'Generate a UUID with `python3 -c "import uuid; print(uuid.uuid4())"` and set DROPCOWBOY_SITE_ID.',
            )
        )

    if mode in ("server", "login") and not config.site_id:
        problems.append(
            problem(
                "missing_site_id",
                "DROPCOWBOY_SITE_ID is required when DC_AUTH_MODE=" + mode + ".",
                "Set DROPCOWBOY_SITE_ID to one UUID per deployed app and keep it stable.",
            )
        )

    if mode == "server":
        problems.extend(_server_mode_problems(config))

    return config, problems


def secret_values(config: Config) -> list[str]:
    """The values that must never appear in a log line or a response.

    Includes every value a secrets provider ever returned, even ones since rotated out.
    """
    values = [
        config.api_key,
        config.api_secret,
        config.passcode,
        *config.webhook_secrets,
        *config.url_secrets,
        *config.known_secrets,
    ]
    return [value for value in values if value]


def _server_mode_problems(config: Config) -> list[BootProblem]:
    problems: list[BootProblem] = []
    if not config.api_key:
        problems.append(
            problem(
                "missing_api_key",
                "DROPCOWBOY_API_KEY is required when DC_AUTH_MODE=server.",
                "Create an API key under Developers > API keys and set DROPCOWBOY_API_KEY.",
            )
        )
    if not config.api_secret:
        problems.append(
            problem(
                "missing_api_secret",
                "DROPCOWBOY_API_SECRET is required when DC_AUTH_MODE=server.",
                "Copy the API secret shown when you created the key into DROPCOWBOY_API_SECRET.",
            )
        )
    # Only the placeholder identity needs it: it IS the user. With passcode it
    # optionally names the one owner, and the others identify real users.
    if not config.starter_user_id and config.identity == "dev":
        problems.append(
            problem(
                "missing_user_id",
                "STARTER_CRM_USER_ID is required when DC_AUTH_MODE=server (it stands in for your signed-in user).",
                "Set STARTER_CRM_USER_ID to a UUID, or set DC_IDENTITY to passcode, oidc or your own provider.",
            )
        )
    elif config.starter_user_id and not UUID.fullmatch(config.starter_user_id):
        problems.append(
            problem(
                "invalid_user_id",
                "STARTER_CRM_USER_ID must be a UUID.",
                "Set STARTER_CRM_USER_ID to a UUID such as 8b6f4c2a-1d3e-4f5a-9b7c-0e2d4f6a8c1e.",
            )
        )
    return problems


def is_provider_path(value: str | None) -> bool:
    """True when a ``DC_<KIND>`` value names your own provider file rather than a built-in.

    Only relative paths count, so a typo such as ``passcod`` is reported as an
    unknown built-in instead of being searched for on disk.

    Args:
        value: The raw variable value.

    Returns:
        True for ``./x.py`` and ``../x.py``.
    """
    return isinstance(value, str) and (value.startswith("./") or value.startswith("../"))


def _on_off(env: Mapping[str, str], name: str, fallback: bool, code: str, problems: list[BootProblem]) -> bool:
    """Reads an ``on``/``off`` switch, recording a problem for anything else."""
    raw = _read(env, name)
    if raw is None:
        return fallback
    value = raw.lower()
    if value not in ("on", "off"):
        problems.append(
            problem(code, name + ' must be on or off (got "' + raw + '").', "Set " + name + " to on or off.")
        )
        return fallback
    return value == "on"


def _parse_origins(raw: str | None, problems: list[BootProblem]) -> list[str]:
    """Parses ``DC_CORS_ORIGINS``: exact origins only, so ``*`` and paths are refused."""
    if not raw:
        return []
    origins: list[str] = []
    for item in (part.strip() for part in raw.split(",")):
        if not item:
            continue
        parsed = urlparse(item)
        bare = (
            parsed.scheme in ("http", "https")
            and bool(parsed.netloc)
            and not parsed.path.strip("/")
            and not parsed.query
            and not parsed.fragment
            and not parsed.username
            # A browser never sends the default port in Origin, so listing it could never match.
            and not parsed.netloc.endswith(":80" if parsed.scheme == "http" else ":443")
            and item.rstrip("/") == parsed.scheme + "://" + parsed.netloc.lower()
        )
        if not bare:
            problems.append(
                problem(
                    "invalid_cors_origins",
                    "DC_CORS_ORIGINS must be a comma-separated list of origins such as https://crm.example.com "
                    '(no path, no *). Bad entry: "' + item + '".',
                    "List each front-end origin exactly, or leave DC_CORS_ORIGINS empty to keep CORS off.",
                )
            )
            continue
        origins.append(parsed.scheme + "://" + parsed.netloc.lower())
    return origins


def _read(env: Mapping[str, str], name: str) -> str | None:
    """The trimmed value of ``name``, or None when it is unset or blank."""
    value = env.get(name)
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value or None


def _whole_number(text: str) -> int | None:
    return int(text) if WHOLE_NUMBER.fullmatch(text) else None


def _int_setting(
    env: Mapping[str, str],
    name: str,
    fallback: int,
    low: int,
    high: int,
    code: str,
    problems: list[BootProblem],
    hint: str = "",
) -> int:
    """Reads a whole-number setting within a range.

    Args:
        env: The process environment.
        name: The variable.
        fallback: The value when unset or bad.
        low: The smallest allowed value.
        high: The largest allowed value.
        code: The problem code to report for a bad value.
        problems: Collects the problem.
        hint: Extra advice for the fix line.

    Returns:
        The value, or the fallback when it was unset or bad.
    """
    raw = _read(env, name)
    if raw is None:
        return fallback
    value = _whole_number(raw)
    if value is None or value < low or value > high:
        problems.append(
            problem(
                code,
                name + " must be a whole number from " + str(low) + " to " + str(high) + ' (got "' + raw + '").',
                "Set " + name + " to " + str(fallback) + " or another value in range." + (" " + hint if hint else ""),
            )
        )
        return fallback
    return value


def _url_passwords(env: Mapping[str, str]) -> list[str]:
    """Collects the passwords inside the database and Redis addresses, for redaction.

    Args:
        env: The process environment.

    Returns:
        Each non-empty password.
    """
    out: list[str] = []
    for value in (
        _read(env, "DC_DATABASE_URL"),
        _read(env, "DATABASE_URL"),
        _read(env, "NETLIFY_DB_URL"),
        redis_url(env),
    ):
        if not value:
            continue
        try:
            password = urlparse(value).password
        except ValueError:
            continue
        if password:
            out.append(unquote(password))
    return out


def _parse_data(env: Mapping[str, str], mode: str, store: str, problems: list[BootProblem]) -> DataSettings:
    """Reads where module documents are kept (``DC_DATA``).

    Mirrors ``parseData`` in the Node config. It follows ``DC_STORE`` (memory, sqlite, postgres or dynamodb), so one
    setting moves everything. A Redis store or your own store cannot hold documents, so server mode then needs
    ``DC_DATA`` named explicitly. Modules only run in server mode (they need a signed-in user), so in the other
    modes the data is in memory and unused.

    Args:
        env: The process environment.
        mode: The ``DC_AUTH_MODE``.
        store: The ``DC_STORE`` value.
        problems: Collects every problem found.

    Returns:
        The ``config.data`` settings.
    """
    explicit = _read(env, "DC_DATA")
    if explicit and explicit not in DATA_PROVIDERS and not is_provider_path(explicit):
        problems.append(
            problem(
                "invalid_data",
                "DC_DATA must be "
                + ", ".join(DATA_PROVIDERS)
                + ', or a relative path to your own data provider (got "'
                + explicit
                + '").',
                "Leave DC_DATA unset to follow DC_STORE, or set it to memory, sqlite, postgres or dynamodb.",
            )
        )
        return DataSettings(provider="memory")
    if mode != "server":
        return DataSettings(provider="memory")
    if explicit:
        return DataSettings(provider=explicit)
    if store in DATA_PROVIDERS or not (store == "redis" or is_provider_path(store)):
        return DataSettings(provider=store if store in DATA_PROVIDERS else "memory")
    problems.append(
        problem(
            "data_provider_required",
            "DC_STORE=" + store + " cannot hold module data (the Deals page and your own modules).",
            "Set DC_DATA=postgres (with DC_DATABASE_URL), DC_DATA=dynamodb (on AWS) or DC_DATA=sqlite (one instance), "
            "or the path of your own data provider.",
        )
    )
    return DataSettings(provider="memory")


def _platform_name(platform: str) -> str:
    """How a platform is named in a message."""
    return "Vercel" if platform == "vercel" else "Netlify"


def _parse_events(env: Mapping[str, str], problems: list[BootProblem], notices: list[str]) -> EventSettings:
    """Reads the event settings and checks that the pieces can work together.

    Mirrors ``parseEvents`` in the Node config: where events are kept, how they reach
    other instances and browsers, and how webhook handlers run.

    Args:
        env: The process environment.
        problems: Collects every problem found.
        notices: Collects facts worth telling the operator at boot that are not problems.

    Returns:
        The ``config.events`` settings.
    """
    has_redis = bool(redis_url(env))
    platform = detect_platform(env)
    # A database the host attached (Neon's integration sets DATABASE_URL, Netlify Database NETLIFY_DB_URL) is the
    # store of a function host.
    attached_database = platform and (
        _read(env, "DC_DATABASE_URL") or _read(env, "DATABASE_URL") or _read(env, "NETLIFY_DB_URL")
    )
    store = _read(env, "DC_STORE") or ("postgres" if attached_database else "memory")
    if store not in STORES and not is_provider_path(store):
        problems.append(
            problem(
                "invalid_store",
                "DC_STORE must be "
                + ", ".join(STORES)
                + ', or a relative path to your own store (got "'
                + store
                + '").',
                "Set DC_STORE to memory (the default), sqlite for one instance, "
                "or postgres, redis or dynamodb for several.",
            )
        )
    durable = store != "memory"
    shared = durable and store != "sqlite"
    worker_in_process = _on_off(env, "DC_WORKER_IN_PROCESS", True, "invalid_worker_in_process", problems)

    # A separate worker finishes events in another process, so the default fan-out must reach across processes.
    fanout_default = "local"
    if shared or is_provider_path(store) or (durable and not worker_in_process):
        fanout_default = "redis" if has_redis else ("postgres" if store == "postgres" else "poll")
    # Serverless: every request may be a different instance, and a pooled database URL does not deliver LISTEN/NOTIFY.
    if platform:
        fanout_default = "redis" if has_redis else "poll"
    fanout = _read(env, "DC_FANOUT") or fanout_default
    if fanout not in FANOUTS and not is_provider_path(fanout):
        problems.append(
            problem(
                "invalid_fanout",
                "DC_FANOUT must be "
                + ", ".join(FANOUTS)
                + ', or a relative path to your own fan-out (got "'
                + fanout
                + '").',
                "Leave DC_FANOUT unset to pick one for your store, or set it to local, redis, postgres or poll.",
            )
        )
    if platform and fanout == "postgres":
        notices.append(
            "DC_FANOUT=postgres needs a direct database connection for LISTEN/NOTIFY, which pooled URLs on "
            + _platform_name(platform)
            + " do not give, so events are fanned out with poll instead. Set DC_REDIS_URL for push delivery."
        )
        fanout = "poll"

    platform_queue = "vercel-queue" if platform == "vercel" else "netlify-async"
    if platform:
        webhooks_default = platform_queue
    elif durable and has_redis:
        webhooks_default = "bullmq"
    else:
        webhooks_default = "sqs" if store == "dynamodb" and _read(env, "DC_SQS_QUEUE_URL") else "store"
    webhooks = _read(env, "DC_WEBHOOKS") or webhooks_default
    if webhooks not in WEBHOOK_MODES and not is_provider_path(webhooks):
        problems.append(
            problem(
                "invalid_webhooks_mode",
                "DC_WEBHOOKS must be "
                + ", ".join(WEBHOOK_MODES)
                + ', or a relative path to your own mode (got "'
                + webhooks
                + '").',
                "Leave DC_WEBHOOKS unset to pick the right one, or set it to "
                "store, bullmq, sqs, vercel-queue, netlify-async, qstash or inline.",
            )
        )

    # Serverless hosts: a function instance lives for a request or a few minutes, so anything that keeps
    # events in one instance, or needs a process that stays up, silently loses events. Refuse at boot.
    serverless_refused = False
    if platform:
        where = _platform_name(platform)
        if store in ("memory", "sqlite"):
            serverless_refused = True
            problems.append(
                problem(
                    "serverless_store",
                    "DC_STORE="
                    + store
                    + " keeps events inside one function instance, and "
                    + where
                    + " runs many and stops them at will, so events would be lost or invisible.",
                    "Set DC_STORE=postgres with DC_DATABASE_URL (Neon), or DC_STORE=redis with DC_REDIS_URL (Upstash)."
                    if platform == "vercel"
                    else "Turn on Netlify Database for the site (it sets NETLIFY_DB_URL), or set "
                    "DC_STORE=postgres with DC_DATABASE_URL, or DC_STORE=redis with DC_REDIS_URL (Upstash).",
                )
            )
        if webhooks == "store":
            problems.append(
                problem(
                    "serverless_webhooks_store",
                    "DC_WEBHOOKS=store drains an outbox with a background worker, and "
                    + where
                    + " freezes the function between requests, so queued events would never be handled.",
                    "Set DC_WEBHOOKS="
                    + platform_queue
                    + ", or qstash (Upstash), or inline to run handlers inside the request.",
                )
            )
        if webhooks in WORKER_MODES and worker_in_process:
            problems.append(
                problem(
                    "serverless_worker",
                    "DC_WEBHOOKS="
                    + webhooks
                    + " needs a worker that polls its queue, and "
                    + where
                    + " cannot keep one running.",
                    "Set DC_WEBHOOKS="
                    + platform_queue
                    + ", or run `npm run worker` elsewhere and set DC_WORKER_IN_PROCESS=off here.",
                )
            )
        if fanout == "local":
            problems.append(
                problem(
                    "serverless_fanout",
                    "DC_FANOUT=local only reaches browsers connected to the same function instance, and "
                    + where
                    + " runs many.",
                    "Leave DC_FANOUT unset (poll, or redis when DC_REDIS_URL is set).",
                )
            )

    # Combinations that cannot work. Each message says which setting to change.
    if not durable and not serverless_refused and fanout in ("redis", "postgres", "poll"):
        problems.append(
            problem(
                "store_not_shared",
                "DC_FANOUT="
                + fanout
                + " carries events between instances, but DC_STORE=memory keeps them in one process.",
                "Set DC_STORE to postgres or redis, or set DC_FANOUT=local.",
            )
        )
    if not durable and not serverless_refused and (webhooks in WORKER_MODES or webhooks in PUSH_MODES):
        problems.append(
            problem(
                "store_not_shared",
                "DC_WEBHOOKS=" + webhooks + " queues event ids, but DC_STORE=memory loses the events on restart.",
                "Set DC_STORE to postgres, redis, dynamodb or sqlite, or set DC_WEBHOOKS=store.",
            )
        )
    if fanout == "postgres" and store != "postgres":
        problems.append(
            problem(
                "fanout_needs_postgres",
                "DC_FANOUT=postgres needs DC_STORE=postgres.",
                "Set DC_STORE=postgres, or choose DC_FANOUT=redis or poll.",
            )
        )
    if not worker_in_process and not durable and webhooks != "inline":
        problems.append(
            problem(
                "worker_needs_shared_store",
                "DC_WORKER_IN_PROCESS=off needs a store another process can read, but DC_STORE=memory is private.",
                "Set DC_STORE to sqlite, postgres, redis or dynamodb, or leave DC_WORKER_IN_PROCESS on.",
            )
        )
    if not worker_in_process and fanout == "local" and webhooks != "inline":
        problems.append(
            problem(
                "worker_needs_fanout",
                "DC_WORKER_IN_PROCESS=off finishes events in another process, but DC_FANOUT=local only reaches "
                "browsers connected to the process that finished them.",
                "Set DC_FANOUT=poll (any store), redis, or postgres, or leave DC_WORKER_IN_PROCESS on.",
            )
        )

    handlers_path = _read(env, "DC_WEBHOOK_HANDLERS")
    if handlers_path and not is_provider_path(handlers_path):
        problems.append(
            problem(
                "invalid_webhook_handlers",
                'DC_WEBHOOK_HANDLERS must be a relative path to your handlers file (got "' + handlers_path + '").',
                "Set DC_WEBHOOK_HANDLERS to a path such as ./handlers.py, or leave it unset.",
            )
        )

    return EventSettings(
        store=store,
        fanout=fanout,
        webhooks=webhooks,
        sqlite_path=_read(env, "DC_SQLITE_PATH") or "data/starter-crm.sqlite",
        retention_hours=_int_setting(env, "DC_EVENT_RETENTION_HOURS", 72, 1, 8760, "invalid_event_retention", problems),
        max_stream_seconds=_int_setting(
            env,
            "DC_EVENTS_MAX_STREAM_SECONDS",
            {"vercel": VERCEL_STREAM_SECONDS, "netlify": NETLIFY_STREAM_SECONDS}.get(platform or "", 0),
            0,
            86400,
            "invalid_max_stream_seconds",
            problems,
            "0 means no cap.",
        ),
        keepalive_seconds=NETLIFY_KEEPALIVE_SECONDS if platform == "netlify" else KEEPALIVE_SECONDS,
        fanout_poll_ms=_int_setting(env, "DC_FANOUT_POLL_MS", 1000, 100, 60000, "invalid_fanout_poll", problems),
        outbox_poll_ms=_int_setting(env, "DC_OUTBOX_POLL_MS", 1000, 100, 60000, "invalid_outbox_poll", problems),
        max_attempts=_int_setting(env, "DC_WEBHOOK_MAX_ATTEMPTS", 8, 1, 50, "invalid_webhook_attempts", problems),
        handler_budget_ms=_int_setting(
            env,
            "DC_WEBHOOK_HANDLER_BUDGET_MS",
            3000,
            100,
            4500,
            "invalid_handler_budget",
            problems,
            "Drop Cowboy waits 5 seconds for the acknowledgement, so it must stay under that.",
        ),
        handlers_path=handlers_path,
        worker_in_process=worker_in_process,
    )
