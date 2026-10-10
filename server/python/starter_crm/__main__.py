"""``python -m starter_crm``: loads .env, checks config, starts listening."""

from __future__ import annotations

import logging
import os
import signal
import sys

from dotenv import load_dotenv
from werkzeug.serving import make_server

from .app import create_app
from .config import load_config, starter_root, secret_values
from .dev_session import is_loopback_address
from .log import Logger, RedactingFilter


def main() -> int:
    # Variables already in the environment win over .env (override=False).
    root = starter_root(os.environ)
    load_dotenv(root / ".env", override=False)

    config, problems = load_config(os.environ, root)
    if problems:
        print(
            "The Starter CRM server cannot start:\n  - "
            + "\n  - ".join(problems)
            + "\nCopy .env.example to .env at the starter root and fill it in.",
            file=sys.stderr,
        )
        return 1

    log = Logger(secret_values(config))
    _quiet_werkzeug(secret_values(config))

    # Flask's development server, one thread per request, which each open
    # /api/events stream needs. See README.md for production.
    server = make_server(config.host, config.port, create_app(config, log=log), threaded=True)
    host, port = server.server_address[0], server.server_port
    shown = "[" + host + "]" if ":" in host else host
    log.info("Starter CRM server (DC_AUTH_MODE=" + config.mode + ") on http://" + shown + ":" + str(port))
    if not is_loopback_address(host) and host != "localhost":
        log.warn("HOST is not loopback: other machines on your network can reach this server.")
    if not config.webhook_secrets:
        log.warn("DROPCOWBOY_WEBHOOK_SECRET is not set, so webhooks will be refused with 503.")

    signal.signal(signal.SIGTERM, _stop)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        # Open event streams run on daemon threads, so they end with the process.
        server.server_close()
    return 0


def _quiet_werkzeug(secrets: list[str]) -> None:
    """Drop the per-request access log, as the Node server has none, and scrub what is left."""
    werkzeug_log = logging.getLogger("werkzeug")
    werkzeug_log.setLevel(logging.WARNING)
    werkzeug_log.addFilter(RedactingFilter(secrets))


def _stop(signum, frame) -> None:
    raise SystemExit(0)


if __name__ == "__main__":
    sys.exit(main())
