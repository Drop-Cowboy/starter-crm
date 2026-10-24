"""The event runtime: the store, the fan-out, the webhook mode and the processor, supervised as one unit.

Where it sits: ``bootstrap()`` builds it from the providers the config names; ``create_app()`` takes it as
``runtime``; ``__main__``, Gunicorn's ``post_worker_init``, ``worker.py`` and ``cli.py`` call ``start()`` in the
process that serves, and ``stop()`` on shutdown. Tests that do not boot use ``default_runtime()``: a memory
store, a local fan-out and inline handling, so a webhook is processed and pushed within the request.

Creating a runtime never connects to anything, so it is safe in Gunicorn's master before the fork. ``start()``
connects each piece, starts the webhook mode's worker (unless ``DC_WORKER_IN_PROCESS=off``) and a maintenance
thread that, every minute, re-queues events no worker has finished (a crash, a flushed Redis) and, hourly,
deletes events past ``DC_EVENT_RETENTION_HOURS``. ``stop()`` waits for work in hand, so shutdown never abandons it.
The Node server has the same shape (``src/runtime.js``).

CONTRACT.md: "Event store", "Fan-out", "POST /webhooks/dropcowboy", Shutdown.
What a customer changes: nothing.
"""

from __future__ import annotations

import threading
from typing import Any

from .processor import Processor
from .providers.data import memory as memory_data
from .providers.fanout import local as local_fanout
from .providers.store import memory as memory_store
from .providers.webhooks import inline as inline_webhooks

# How often the maintenance thread looks for events no worker has finished.
SWEEP_EVERY_SECONDS = 60

# How many sweeps pass between retention prunes (60 sweeps is an hour).
PRUNE_EVERY_SWEEPS = 60

# How many stale events one sweep re-queues.
SWEEP_BATCH = 50


class Runtime:
    """Wires the four pieces together and runs the maintenance thread."""

    def __init__(
        self,
        config: Any,
        store: Any,
        fanout: Any,
        dispatcher: Any,
        processor: Any,
        log: Any,
        data: Any = None,
        modules: Any = None,
    ):
        """Creates the runtime from instances that have not been started.

        Args:
            config: The loaded config.
            store: The event store.
            fanout: The fan-out.
            dispatcher: The webhook mode.
            processor: The processor.
            log: The redacting logger.
            data: The module data provider (None when nothing needs it).
            modules: The module runtime with the routes and the event runner (None when there are none).
        """
        self.config = config
        self.store = store
        self.fanout = fanout
        self.dispatcher = dispatcher
        self.processor = processor
        self.data = data
        self.modules = modules
        self._log = log
        self._running = False
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._start_lock = threading.Lock()

    def start(self) -> None:
        """Connects every piece, starts the worker and the maintenance thread, and prunes once. Safe to call twice.

        Raises:
            Exception: Whatever a piece raises when it cannot connect; the process should exit.
        """
        with self._start_lock:
            if self._running:
                return
            self._call_start(self.store)
            self._call_start(self.data)
            self._call_start(self.fanout)
            self.store.prune()
            self._call_start(self.dispatcher)
            self._stop.clear()
            self._running = True
            self._thread = threading.Thread(target=self._maintenance, name="starter-crm-maintenance", daemon=True)
            self._thread.start()

    @staticmethod
    def _call_start(piece: Any) -> None:
        """Calls a piece's ``start()`` when it has one (a custom provider need not)."""
        start = getattr(piece, "start", None)
        if callable(start):
            start()

    def maintain_once(self) -> None:
        """One full maintenance pass: re-queue stale events and prune past retention.

        Serverless hosts have no loop, so a scheduled request calls this instead.
        """
        self._maintain(PRUNE_EVERY_SWEEPS)

    def stop(self) -> None:
        """Stops the maintenance thread and the worker (waiting for work in hand), then closes every connection."""
        with self._start_lock:
            if not self._running:
                return
            self._running = False
            self._stop.set()
            if self._thread is not None:
                self._thread.join()
                self._thread = None
            self.dispatcher.stop()
            self.fanout.close()
            if self.data is not None:
                self.data.close()
            self.store.close()

    def ready(self) -> bool:
        """Whether every piece can do its job: what ``/readyz`` reports.

        Returns:
            False when the store, module data, fan-out or webhook mode is unhealthy.
        """
        return bool(
            self.store.ready()
            and (self.data is None or self.data.ready())
            and self.fanout.ready()
            and self.dispatcher.ready()
        )

    def _maintenance(self) -> None:
        """Sleeps, then maintains, until ``stop()``."""
        count = 0
        while not self._stop.wait(SWEEP_EVERY_SECONDS):
            count += 1
            try:
                self._maintain(count)
            except Exception as err:  # noqa: BLE001 - maintenance must keep running
                self._log.warn("Event maintenance failed; it will try again:", str(err))

    def _maintain(self, count: int) -> None:
        """One pass: re-queue stale events through the webhook mode, and now and then prune.

        Args:
            count: Which pass this is, counting from 1.
        """
        if callable(getattr(self.dispatcher, "sweep", None)):
            due = self.store.pending(limit=SWEEP_BATCH, lease_ms=SWEEP_EVERY_SECONDS * 1000)
            if due:
                self._log.warn("Re-queueing " + str(len(due)) + " event(s) that no worker finished.")
                self.dispatcher.sweep([row["event_id"] for row in due])
        if count % PRUNE_EVERY_SWEEPS == 0:
            self.store.prune()


def default_runtime(config: Any, log: Any, handlers: dict | None = None) -> Runtime:
    """A runtime with no external services: memory store and data, local fan-out, inline handling.

    Args:
        config: The loaded config.
        log: The redacting logger.
        handlers: Handlers to run (none by default).

    Returns:
        A runtime that is ready to use without ``start()``.
    """
    store = memory_store.MemoryStore(config)
    fanout = local_fanout.LocalFanout()
    processor = Processor(config, store, fanout, handlers or {}, log)
    dispatcher = inline_webhooks.InlineDispatcher(config, processor)
    return Runtime(config, store, fanout, dispatcher, processor, log, data=memory_data.MemoryData())
