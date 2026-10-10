"""``create_app(config)``: wires the routes. Tests use it without listening."""

from __future__ import annotations

from flask import Flask, jsonify

from .auth import require_login, require_user
from .config import Config, secret_values
from .dev_session import dev_session_view
from .errors import register_error_handlers
from .events import EventStore, events_view
from .log import Logger
from .readiness import readiness_view
from .static import static_view
from .token import token_view
from .webhooks import webhook_view

MAX_BODY_BYTES = 1024 * 1024


def create_app(config: Config, log: Logger | None = None, store: EventStore | None = None) -> Flask:
    """Builds the Flask app. ``log`` and ``store`` let tests swap the logger and the event store."""
    log = log or Logger(secret_values(config))
    store = store or EventStore()
    user = require_user(config)

    # static_folder=None: the front-ends are served by static.py, and Flask's
    # own /static route would shadow a vanilla/static/ folder.
    app = Flask(__name__, static_folder=None)
    app.config["MAX_CONTENT_LENGTH"] = MAX_BODY_BYTES
    # Keep keys in the order written, as Node does, rather than sorted.
    app.json.sort_keys = False

    @app.after_request
    def security_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    @app.get("/healthz")
    def healthz():
        return jsonify({"ok": True})

    @app.get("/api/config")
    def api_config():
        return jsonify(public_config(config))

    # server mode mints for your user with your API key; login mode mints
    # for whoever signed in with Drop Cowboy, using their access token.
    if config.mode in ("server", "login"):
        caller = require_login if config.mode == "login" else user
        app.add_url_rule("/api/dropcowboy/token", "token", caller(token_view(config)), methods=["POST"])
        app.add_url_rule("/api/dropcowboy/readiness", "readiness", caller(readiness_view(config)), methods=["GET"])

    if config.mode == "mcp-session":
        app.add_url_rule("/__dev/session", "dev_session", dev_session_view(config), methods=["GET"])

    # webhook_view reads the raw body itself. Never call request.get_json()
    # on this route: the signature covers the exact bytes received.
    app.add_url_rule("/webhooks/dropcowboy", "webhook", webhook_view(config, store, log), methods=["POST"])
    app.add_url_rule("/api/events", "events", user(events_view(store)), methods=["GET"])

    # Everything else is a front-end file. static_view answers 404 for
    # /api/..., /__dev/..., /webhooks/... and /healthz/... itself.
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
