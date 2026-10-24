"""WSGI entry for Gunicorn in production.

Where it sits: ``gunicorn -c gunicorn.conf.py starter_crm.wsgi:app`` loads
this module. It validates config at import time so a bad deploy fails at boot
with the same structured problems as ``python -m starter_crm``.

CONTRACT.md: Boot, Shutdown (graceful timeout comes from gunicorn.conf.py).
Customers set env vars; they should not need to edit this file.
"""

from __future__ import annotations

import os
import signal
import sys

from dotenv import load_dotenv

from .app import create_app
from .bootstrap import bootstrap
from .config import starter_root
from .problems import format_problems

root = starter_root(os.environ)
load_dotenv(root / ".env", override=False)

_booted = bootstrap(os.environ, root)
if _booted.problems:
    print(
        "The Starter CRM server cannot start:\n"
        + format_problems(_booted.problems)
        + "\nEach problem above names the setting to change: in .env at the starter root when you run it yourself"
        + " (npm run setup writes one), or in your host's settings. More help: TROUBLESHOOTING.md.",
        file=sys.stderr,
    )
    raise SystemExit(1)

# The dev entry point (__main__.py) and the Node server both print where Drop
# Cowboy should send webhooks; Gunicorn skips __main__, so say it here too, once,
# in the master before any worker forks. Without it a container deploy
# gives no hint of the URL to register.
if _booted.config.public_url:
    _booted.log.info("Point Drop Cowboy webhooks at " + _booted.config.public_url + "/webhooks/dropcowboy")

app = create_app(
    _booted.config,
    log=_booted.log,
    identity=_booted.identity,
    ratelimit=_booted.ratelimit,
    observer=_booted.observer,
    secrets=_booted.secrets,
    runtime=_booted.runtime,
)


def _drain() -> None:
    """Marks the worker draining and closes every open SSE stream."""
    lifecycle = app.config.get("STARTER_CRM_LIFECYCLE")
    if lifecycle is not None:
        lifecycle.begin_drain()


def worker_int(worker) -> None:
    """Gunicorn hook: close SSE streams when a worker receives SIGINT or SIGQUIT."""
    _drain()


def post_worker_init(worker) -> None:
    """Gunicorn hook: start the event runtime, and close SSE streams the moment a worker receives SIGTERM.

    The event runtime connects here, in the worker, not in the master: a database pool, a Redis connection
    or a thread created before the fork would be broken in the child. If it cannot connect the worker fails
    to boot, and Gunicorn then exits the whole container with the error, as it does for a bad config.

    Gunicorn's own SIGTERM handler only stops accepting new connections and then
    waits for open ones, and an SSE stream never ends by itself, so without this
    the worker would sit until the graceful timeout and be killed. The handler
    drains first, then hands over to gunicorn's so it exits as usual.

    Args:
        worker: The gunicorn worker that has just finished starting.
    """
    _booted.runtime.start()
    previous = signal.getsignal(signal.SIGTERM)

    def drain_then_stop(signum, frame) -> None:
        _drain()
        if callable(previous):
            previous(signum, frame)

    signal.signal(signal.SIGTERM, drain_then_stop)


def worker_exit(server, worker) -> None:
    """Gunicorn hook: wait for the webhook worker's event in hand, then close the event runtime's connections.

    Args:
        server: The Gunicorn arbiter.
        worker: The worker that has exited.
    """
    _booted.runtime.stop()
