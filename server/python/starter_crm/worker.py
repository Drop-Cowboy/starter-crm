"""``python -m starter_crm.worker``: a separate webhook worker.

Where it sits: with ``DC_WORKER_IN_PROCESS=off`` on the web instances, this process takes the handler work
(the outbox for ``DC_WEBHOOKS=store``, the queue for ``bullmq``). It boots the same config and providers as the
server, so it needs the same ``.env``, and a store and fan-out that other processes can reach: a ``sqlite`` file
on the same machine, or ``postgres`` or ``redis``, with ``DC_FANOUT`` set to ``poll``, ``redis`` or ``postgres``.
It serves no HTTP. On SIGTERM it finishes the event in hand and exits.

CONTRACT.md: "POST /webhooks/dropcowboy" (Processing), Shutdown.
What a customer changes: nothing.
"""

from __future__ import annotations

import os
import signal
import sys
import threading

from dotenv import load_dotenv

from .bootstrap import bootstrap
from .config import starter_root
from .problems import format_problems


def main() -> int:
    """Boots, starts the runtime's worker and waits for SIGTERM.

    Returns:
        The process exit code: 0 after a clean stop, 1 when the configuration or the services have problems.
    """
    root = starter_root(os.environ)
    load_dotenv(root / ".env", override=False)
    booted = bootstrap(os.environ, root)
    if booted.problems:
        print("The Starter CRM worker cannot start:\n" + format_problems(booted.problems), file=sys.stderr)
        return 1

    config, log, runtime = booted.config, booted.log, booted.runtime
    if config.events.store == "memory":
        log.error(
            "A separate worker needs a store the web process can also read. Set DC_STORE to sqlite, postgres or redis."
        )
        return 1
    if config.events.fanout == "local":
        log.error(
            "A separate worker needs a fan-out that reaches the web process. Set DC_FANOUT to poll, redis or postgres."
        )
        return 1

    # This process exists to run the worker, whatever DC_WORKER_IN_PROCESS says for the web instances.
    config.events.worker_in_process = True
    try:
        runtime.start()
    except Exception as err:  # noqa: BLE001 - any failure to reach the store, Redis or the queue is a boot failure
        log.error("Could not start the event runtime: " + (str(err) or err.__class__.__name__))
        return 1
    log.info(
        "Starter CRM worker running (DC_STORE=" + config.events.store + ", DC_WEBHOOKS=" + config.events.webhooks + ")."
    )

    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda signum, frame: stop.set())
    signal.signal(signal.SIGINT, lambda signum, frame: stop.set())
    stop.wait()
    runtime.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
