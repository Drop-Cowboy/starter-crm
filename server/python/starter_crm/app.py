"""``create_app(config)``: wires the routes and the request pipeline. Tests use it without listening.

Where it sits: browser and Drop Cowboy hit these routes; ``__main__`` and
Gunicorn load the app. Tests call ``create_app()`` with a test client. Every
request passes through the same pipeline: a request id, the secrets refresh, the
``on_request`` hook, the route, then the security headers, CORS, the access log
and the ``on_response`` hook.

CONTRACT.md: every route in "Routes", plus "Request ids", "Response headers" and "CORS".
Customers add module routes and swap the identity provider; keep
``public_config()`` free of secrets.
"""

from __future__ import annotations

import functools
import math
import re
import time
import uuid
from collections.abc import Callable
from typing import Any

from flask import Flask, g, jsonify, request

from .auth import require_login, require_user
from .config import Config, secret_values
from .dev_session import dev_session_view
from .errors import HttpError, not_found_response, register_error_handlers
from .events import events_view
from .hooks import Hooks
from .lifecycle import Lifecycle
from .log import Logger
from .providers import ProviderContext
from .providers.identity import dev as dev_identity
from .providers.ratelimit import memory as memory_limiter
from .providers.ratelimit import off as off_limiter
from .readiness import readiness_view
from .runtime import Runtime, default_runtime
from .security import apply_cors, apply_security_headers, preflight
from .static import static_view
from .token import token_view
from .webhooks import webhook_status_view, webhook_view

MAX_BODY_BYTES = 1024 * 1024

# Every limit is a fixed one-minute window.
WINDOW_SECONDS = 60
TOKEN_PER_IP_PER_MINUTE = 300
DEV_SESSION_PER_IP_PER_MINUTE = 10

# An inbound X-Request-Id is kept only when it is short and made of safe characters,
# so a caller cannot smuggle a newline or a script into a log line.
REQUEST_ID = re.compile(r"[A-Za-z0-9._-]{1,64}")


def pick_request_id(header: str | None) -> str:
    """Keeps a well-formed inbound ``X-Request-Id``, otherwise makes a new UUID.

    Args:
        header: The inbound header value, or None.

    Returns:
        The id to use for this request.
    """
    if header and REQUEST_ID.fullmatch(header):
        return header
    return str(uuid.uuid4())


def client_ip(forwarded_for: str | None, peer: str | None, trust_proxy: int) -> str:
    """The caller's address, counting ``trust_proxy`` hops of ``X-Forwarded-For`` from the right.

    The chain is the header's entries followed by the TCP peer. With ``trust_proxy=1``
    that is the entry the nearest proxy appended, so a spoofed entry further left changes nothing.

    Args:
        forwarded_for: The ``X-Forwarded-For`` header, or None.
        peer: The socket address of the connection.
        trust_proxy: ``DC_TRUST_PROXY``.

    Returns:
        The client address, or ``unknown`` when nothing is known.
    """
    address = peer or "unknown"
    if trust_proxy < 1:
        return address
    chain = [part.strip() for part in (forwarded_for or "").split(",") if part.strip()]
    if address != "unknown":
        chain.append(address)
    if not chain:
        return address
    return chain[max(0, len(chain) - 1 - trust_proxy)]


def create_app(
    config: Config,
    log: Logger | None = None,
    runtime: Runtime | None = None,
    lifecycle: Lifecycle | None = None,
    identity: Any = None,
    ratelimit: Any = None,
    observer: Any = None,
    secrets: Any = None,
) -> Flask:
    """Builds the Flask app.

    Args:
        config: Validated config from ``load_config``.
        log: Optional logger stand-in for tests.
        runtime: The event runtime (store, fan-out, webhook mode); defaults to a memory one with inline handling.
        lifecycle: Optional lifecycle; created when omitted.
        identity: The identity provider instance; defaults to the ``dev`` identity.
        ratelimit: The rate limiter instance; defaults to the one ``DC_RATE_LIMIT`` names.
        observer: The observer instance, or None.
        secrets: The secrets refresh runtime, or None.

    Returns:
        A Flask app with all contract routes registered.
    """
    log = log or Logger(lambda: secret_values(config), fmt=config.log_format)
    runtime = runtime or default_runtime(config, log)
    lifecycle = lifecycle or Lifecycle(runtime, config.shutdown_grace_seconds)
    # Identity is only used in server mode; the other modes get the always-passing placeholder.
    identity = identity or dev_identity.create(ProviderContext(config, {}, log, config.root))
    limiter = ratelimit or (off_limiter.create() if config.rate_limit == "off" else memory_limiter.create())
    hooks = Hooks(observer, log)
    user = require_user(identity, config)

    # static_folder=None: the front-ends are served by static.py, and Flask's
    # own /static route would shadow a vanilla/static/ folder.
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = MAX_BODY_BYTES
    # Keep keys in the order written, as Node does, rather than sorted.
    app.json.sort_keys = False
    app.config["STARTER_CRM_LIFECYCLE"] = lifecycle
    app.config["STARTER_CRM_RUNTIME"] = runtime
    app.config["STARTER_CRM_HOOKS"] = hooks

    def limit(bucket: str, key: str | None, maximum: int) -> None:
        """Counts one hit against a limit and raises 429 when it is over.

        Args:
            bucket: Which limit, such as ``token-ip``.
            key: Who it is counted for: an IP, a user id or a token hash.
            maximum: Hits allowed per window.

        Raises:
            HttpError: 429 ``rate_limited`` with ``Retry-After``.
        """
        result = limiter.hit(bucket + ":" + str(key), maximum, WINDOW_SECONDS)
        if not result["allowed"]:
            wait = max(1, math.ceil(result.get("retry_after_seconds") or 1))
            raise HttpError(
                429,
                "rate_limited",
                "Too many requests. Try again in " + str(wait) + " seconds.",
                {"Retry-After": str(wait)},
            )

    def per_ip(bucket: str, maximum: int) -> Callable:
        """Builds a decorator that counts the caller's IP before the view runs."""

        def decorate(view: Callable) -> Callable:
            @functools.wraps(view)
            def limited(*args, **kwargs):
                limit(bucket, g.client_ip, maximum)
                return view(*args, **kwargs)

            return limited

        return decorate

    @app.before_request
    def begin_request():
        g.request_id = pick_request_id(request.headers.get("X-Request-Id"))
        g.started = time.perf_counter()
        g.log = log.child({"request_id": g.request_id}) if hasattr(log, "child") else log
        g.hooks = hooks
        g.limit = limit
        g.client_ip = client_ip(
            request.headers.get("X-Forwarded-For"), request.environ.get("REMOTE_ADDR"), config.trust_proxy
        )
        # Done here, inside the request, so it works on hosts that freeze the process between requests.
        if secrets is not None:
            secrets.refresh_if_due()
        hooks.on_request(
            {"request_id": g.request_id, "method": request.method, "path": request.path, "client_ip": g.client_ip}
        )
        # OPTIONS is only ever a CORS preflight, and only when CORS is on.
        if request.method == "OPTIONS":
            return preflight(config) or not_found_response()
        return None

    @app.after_request
    def finish_request(response):
        apply_security_headers(response, config)
        apply_cors(response, config)
        request_id = g.get("request_id")
        if request_id is None:
            return response
        response.headers["X-Request-Id"] = request_id
        duration_ms = round((time.perf_counter() - g.started) * 1000)
        if config.log_requests and hasattr(g.log, "access"):
            g.log.access(
                {
                    "method": request.method,
                    "path": request.path,
                    "status": response.status_code,
                    "duration_ms": duration_ms,
                }
            )
        hooks.on_response(
            {
                "request_id": request_id,
                "method": request.method,
                "path": request.path,
                "status": response.status_code,
                "duration_ms": duration_ms,
            }
        )
        return response

    @app.get("/healthz")
    def healthz():
        return jsonify({"ok": True})

    @app.get("/readyz")
    def readyz():
        result = lifecycle.check_ready()
        if not result.get("ok"):
            return jsonify({"ok": False, "reason": result.get("reason") or "not_ready"}), 503
        return jsonify({"ok": True})

    @app.get("/api/config")
    def api_config():
        return jsonify(public_config(config))

    # server mode mints for your user with your API key; login mode mints
    # for whoever signed in with Drop Cowboy, using their access token.
    if config.mode in ("server", "login"):
        caller = require_login if config.mode == "login" else user
        token_limited = per_ip("token-ip", TOKEN_PER_IP_PER_MINUTE)
        app.add_url_rule("/api/dropcowboy/token", "token", token_limited(caller(token_view(config))), methods=["POST"])
        app.add_url_rule("/api/dropcowboy/readiness", "readiness", caller(readiness_view(config)), methods=["GET"])

    # The session endpoint never answers 401: it is how a page learns whether to show a sign-in screen.
    if config.mode == "server":

        def auth_session():
            found = None
            try:
                found = identity.authenticate(request)
            except HttpError as err:
                if err.status != 401:
                    raise
            shown = None
            if found:
                shown = {"id": found.get("id")}
                if found.get("email"):
                    shown["email"] = found["email"]
                if found.get("name"):
                    shown["name"] = found["name"]
            response = jsonify({"identity": config.identity_kind, "signed_in": bool(found), "user": shown})
            response.headers["Cache-Control"] = "no-store"
            return response

        app.add_url_rule("/api/auth/session", "auth_session", auth_session, methods=["GET"])
        routes = identity.routes() if callable(getattr(identity, "routes", None)) else []
        for route in routes:
            app.add_url_rule(route["path"], "identity_" + route["path"], route["handler"], methods=[route["method"]])

    if config.mode == "mcp-session":
        dev_session = per_ip("dev-session", DEV_SESSION_PER_IP_PER_MINUTE)(dev_session_view(config))
        app.add_url_rule("/__dev/session", "dev_session", dev_session, methods=["GET"])

    # webhook_view reads the raw body itself. Never call request.get_json()
    # on this route: the signature covers the exact bytes received.
    app.add_url_rule("/webhooks/dropcowboy", "webhook", webhook_view(config, runtime), methods=["POST"])
    app.add_url_rule(
        "/api/webhooks/status", "webhook_status", user(webhook_status_view(config, runtime)), methods=["GET"]
    )
    app.add_url_rule("/api/events", "events", user(events_view(runtime, lifecycle)), methods=["GET"])
    # A queue-backed webhook mode adds the route its queue calls back (for example QStash's /internal/webhook-jobs).
    # Each such route checks its caller itself, so none of them takes the `user` wrapper.
    for route in runtime.dispatcher.routes() if callable(getattr(runtime.dispatcher, "routes", None)) else []:
        app.add_url_rule(route["path"], "dispatcher_" + route["path"], route["handler"], methods=[route["method"]])

    # Modules need a signed-in user, so only server mode serves them.
    if config.mode == "server" and runtime.modules is not None:
        for route in runtime.modules.routes:
            endpoint = "module_" + route.method + "_" + route.flask_path
            app.add_url_rule(route.flask_path, endpoint, user(runtime.modules.view_for(route)), methods=[route.method])

    # Everything else is a front-end file. static_view answers 404 for
    # /api/..., /__dev/..., /webhooks/..., /healthz/... and /readyz/... itself.
    serve_front_end = static_view(config)
    app.add_url_rule("/", "front_end_root", serve_front_end, defaults={"subpath": ""}, methods=["GET"])
    app.add_url_rule("/<path:subpath>", "front_end", serve_front_end, methods=["GET"])

    register_error_handlers(app, log)
    return app


def public_config(config: Config) -> dict:
    """Everything here reaches the browser. Never add a secret."""
    auth0 = None
    if config.mode == "login":
        auth0 = {
            "domain": config.auth0.domain,
            "client_id": config.auth0.client_id,
            "audience": config.auth0.audience,
        }
    return {
        "auth_mode": config.mode,
        "site_id": config.site_id,
        "api_base": config.api_base,
        "cdn_version": config.cdn_version,
        "auth0": auth0,
    }
