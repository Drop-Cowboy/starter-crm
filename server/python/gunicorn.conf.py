"""Gunicorn settings for the Starter CRM Python server in production.

Where it sits: ``gunicorn -c gunicorn.conf.py starter_crm.wsgi:app``.
``graceful_timeout`` aligns with DC_SHUTDOWN_GRACE_SECONDS (default 10) so
open SSE streams get ``retry: 1000`` and close before the worker is killed.

CONTRACT.md: Shutdown.
Customers may raise workers or change the bind address; keep
``graceful_timeout`` in sync with DC_SHUTDOWN_GRACE_SECONDS.
"""

import os

bind = os.environ.get("HOST", "127.0.0.1") + ":" + os.environ.get("PORT", "8080")
# One thread per open /api/events stream needs threads or gevent; sync workers
# with threads cover the starter's SSE model without extra deps.
worker_class = "gthread"
# One worker by default: the default memory event store lives in process memory, so a
# second worker would receive some webhooks and serve some streams without ever
# seeing the other's events. Threads give the concurrency. Raise WEB_CONCURRENCY
# only with a shared store (DC_STORE=postgres or redis) and a fan-out that reaches
# every worker (DC_FANOUT=redis, postgres or poll). sqlite also works, but only on one machine.
workers = int(os.environ.get("WEB_CONCURRENCY", "1"))
threads = int(os.environ.get("GUNICORN_THREADS", "8"))
# Match DC_SHUTDOWN_GRACE_SECONDS (default 10). Gunicorn waits this long after
# SIGTERM before killing the worker; wsgi.worker_int closes SSE streams first.
graceful_timeout = int(os.environ.get("DC_SHUTDOWN_GRACE_SECONDS", "10"))
timeout = max(30, graceful_timeout + 20)
keepalive = 5
# No access log, as the Node server has none. Gunicorn's logs the raw request
# line, and the event-stream and webhook URLs can carry a site token in the
# query string, which must never reach the logs.
accesslog = None
errorlog = "-"
capture_output = True

# Load the app once, in the master, before any worker forks. A bad deploy
# (missing credentials, a non-UUID site id) then exits the whole container
# with the problem list, instead of every worker crash-looping while the
# container still looks alive.
preload_app = True


def post_worker_init(worker):
    """Closes open SSE streams on SIGTERM; see starter_crm.wsgi.post_worker_init."""
    from starter_crm import wsgi

    wsgi.post_worker_init(worker)


def worker_int(worker):
    """Closes open SSE streams on SIGINT or SIGQUIT; see starter_crm.wsgi.worker_int."""
    from starter_crm import wsgi

    wsgi.worker_int(worker)


def worker_exit(server, worker):
    """Closes the event runtime when a worker exits; see starter_crm.wsgi.worker_exit."""
    from starter_crm import wsgi

    wsgi.worker_exit(server, worker)
