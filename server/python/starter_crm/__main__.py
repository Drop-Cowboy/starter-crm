"""``python -m starter_crm``: loads .env, checks config, starts listening.

Where it sits: local development entry. Production uses Gunicorn via
``starter_crm.wsgi:app`` (see README and PRODUCTION.md).

CONTRACT.md: Boot, Shutdown.
"""

from __future__ import annotations

import logging
import os
import signal
import sys
import threading

from dotenv import load_dotenv
from werkzeug.serving import make_server

from .app import create_app
from .bootstrap import bootstrap
from .config import secret_values, starter_root
from .dev_session import is_loopback_address
from .log import RedactingFilter
from .problems import format_problems


def main() -> int:
    """Loads config, prints boot problems or starts the server.

    Returns:
        The process exit code: 0 after a clean stop, 1 when the configuration
        has problems (so a process manager does not restart-loop silently).
    """
    # Variables already in the environment win over .env (override=False).
    root = starter_root(os.environ)
    load_dotenv(root / ".env", override=False)

    booted = bootstrap(os.environ, root)
    if booted.problems:
        print(
            "The Starter CRM server cannot start:\n"
            + format_problems(booted.problems)
            + "\nEach problem above names the setting to change: in .env at the starter root when you run it yourself"
            + " (npm run setup writes one), or in your host's settings. More help: TROUBLESHOOTING.md.",
            file=sys.stderr,
        )
        return 1

    config, log = booted.config, booted.log
    _quiet_werkzeug(lambda: secret_values(config))

    app = create_app(
        config,
        log=log,
        identity=booted.identity,
        ratelimit=booted.ratelimit,
        observer=booted.observer,
        secrets=booted.secrets,
        runtime=booted.runtime,
    )
    lifecycle = app.config["STARTER_CRM_LIFECYCLE"]
    runtime = booted.runtime
    try:
        runtime.start()
    except Exception as err:  # noqa: BLE001 - any failure to reach the store, Redis or the queue is a boot failure
        log.error("Could not start the event runtime: " + (str(err) or err.__class__.__name__))
        return 1

    # Flask's development server, one thread per request, which each open
    # /api/events stream needs. Production: gunicorn -c gunicorn.conf.py …
    server = make_server(config.host, config.port, app, threaded=True)
    host, port = server.server_address[0], server.server_port
    shown = "[" + host + "]" if ":" in host else host
    log.info(
        "Starter CRM server (DC_AUTH_MODE="
        + config.mode
        + ", DC_ENV="
        + config.env
        + ", DC_IDENTITY="
        + config.identity
        + ") on http://"
        + shown
        + ":"
        + str(port)
    )
    log.info(
        "Events: DC_STORE="
        + config.events.store
        + ", DC_FANOUT="
        + config.events.fanout
        + ", DC_WEBHOOKS="
        + config.events.webhooks
        + ("" if config.events.worker_in_process else " (worker runs separately: python -m starter_crm.worker)")
    )
    if not is_loopback_address(host) and host != "localhost":
        log.warn("HOST is not loopback: other machines on your network can reach this server.")
    if not config.webhook_secrets:
        log.warn("DROPCOWBOY_WEBHOOK_SECRET is not set, so webhooks will be refused with 503.")
    if config.public_url:
        log.info("Point Drop Cowboy webhooks at " + config.public_url + "/webhooks/dropcowboy")

    stop = threading.Event()

    def on_signal(signum, frame) -> None:
        if stop.is_set():
            return
        stop.set()
        lifecycle.begin_drain()
        # serve_forever runs on this thread and shutdown() waits for it to return, so calling it
        # here would never finish: the handler would be waiting for the loop it interrupted.
        threading.Thread(target=server.shutdown, name="shutdown", daemon=True).start()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        runtime.stop()
    return 0


def _quiet_werkzeug(secrets) -> None:
    """Drop the per-request access log, as the Node server has none, and scrub what is left."""
    werkzeug_log = logging.getLogger("werkzeug")
    werkzeug_log.setLevel(logging.WARNING)
    werkzeug_log.addFilter(RedactingFilter(secrets))


if __name__ == "__main__":
    sys.exit(main())
