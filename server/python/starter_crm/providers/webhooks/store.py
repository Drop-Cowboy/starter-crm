"""The ``store`` webhook mode: a durable outbox in the event store.

Where it sits: ``DC_WEBHOOKS=store``, the default whenever no queue is configured, on a
long-running host. The webhook records the event as ``received`` and answers 200; a worker
then picks received events up from the store, runs the handlers, and finishes them. Because
the event is in the store before the answer, a crash loses nothing: the next worker finds it.
Nothing needs installing beyond the store you already chose.

The worker runs in the web process by default and backs off while the store is down. Set
``DC_WORKER_IN_PROCESS=off`` and run ``python -m starter_crm.worker`` to move it to its own
process (it needs a shared store: sqlite on one machine, or postgres or redis). On SIGTERM it
waits for the event in hand, up to the shutdown grace period.

Dispatcher interface: ``dispatch(event_id)`` -> ``{"outcome"}``, ``start()``, ``stop()``,
``ready()``, optional ``sweep(event_ids)``, and ``visible_delay_ms``: how long a freshly
recorded event stays out of the sweep's reach.

CONTRACT.md: "POST /webhooks/dropcowboy" (Processing).
Env: DC_OUTBOX_POLL_MS, DC_WORKER_IN_PROCESS. What a customer changes: nothing.
"""

from __future__ import annotations

import threading
from typing import Any

from ...problems import BootProblem

name = "store"
config_keys = ["DC_OUTBOX_POLL_MS", "DC_WORKER_IN_PROCESS"]

# How many received events one pass claims.
BATCH = 10

# How long a worker holds a claimed event before another worker may take it.
LEASE_MS = 60000


def validate(env: Any) -> list[BootProblem]:
    """Nothing beyond the settings the config parser checks.

    Args:
        env: The merged environment (unused).

    Returns:
        No problems.
    """
    return []


class StoreDispatcher:
    """An outbox worker thread over the event store."""

    visible_delay_ms = 0

    def __init__(self, config: Any, store: Any, processor: Any, log: Any):
        """Creates the dispatcher; the worker thread starts with ``start()``.

        Args:
            config: The loaded config (poll interval, worker setting).
            store: The event store, whose ``pending()`` is the outbox.
            processor: The processor that runs handlers.
            log: The redacting logger.
        """
        self._config = config
        self._poll = config.events.outbox_poll_ms / 1000
        self._store = store
        self._processor = processor
        self._log = log
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_error: Exception | None = None

    def dispatch(self, event_id: str) -> dict:
        """Wakes the worker; the event is already recorded, so this only saves it the wait for the next poll.

        Args:
            event_id: The recorded event.

        Returns:
            ``{"outcome": "queued"}``.
        """
        self._wake.set()
        return {"outcome": "queued"}

    def start(self) -> None:
        """Starts the worker thread, unless ``DC_WORKER_IN_PROCESS=off`` or it is running."""
        if not self._config.events.worker_in_process or self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._work, name="starter-crm-outbox", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stops the worker after the event in hand has finished."""
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join()
            self._thread = None

    def ready(self) -> bool:
        """Whether the worker could read the store last time.

        Returns:
            False while the store is unreachable.
        """
        return self._last_error is None

    def _work(self) -> None:
        """The worker: claims due events, processes them, and rests when there is nothing to do."""
        failures = 0
        while not self._stop.is_set():
            try:
                claimed = self._store.pending(limit=BATCH, lease_ms=LEASE_MS)
                failures = 0
                self._last_error = None
            except Exception as err:  # noqa: BLE001 - any store error: back off and try again
                self._last_error = err
                failures += 1
                self._log.error("The outbox could not read the event store:", str(err))
                # Back off while the store is down, up to 30 seconds.
                if self._stop.wait(min(self._poll * 2**failures, 30)):
                    return
                continue
            for row in claimed:
                try:
                    self._processor.process(row["event_id"])
                except Exception as err:  # noqa: BLE001 - one event must not stop the worker
                    self._log.error("The outbox could not process " + row["event_id"] + ":", str(err))
            if len(claimed) < BATCH and not self._stop.is_set():
                # A webhook that arrived while the worker was busy has already set the wake flag.
                self._wake.wait(self._poll)
                self._wake.clear()


def create(ctx: Any) -> StoreDispatcher:
    """Creates the dispatcher.

    Args:
        ctx: The provider context (``config``, ``store``, ``processor``, ``log``).

    Returns:
        The dispatcher instance.
    """
    return StoreDispatcher(ctx.config, ctx.store, ctx.processor, ctx.log)
