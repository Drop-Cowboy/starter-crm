"""The event processor: what happens to an event after the webhook has recorded it.

Where it sits: every webhook mode (store outbox, BullMQ, inline) ends up calling
``process(event_id)``. It reads the event from the store, runs your handlers, finishes the
event (``processed``, or ``failed`` once ``DC_WEBHOOK_MAX_ATTEMPTS`` runs have failed), and
publishes it to the fan-out so browsers see it. One function does all of that so every mode
behaves the same way: the modes differ only in how an event id reaches here.

Because delivery is at-least-once, ``process()`` is safe to call again for an event that has
already finished: it does nothing and says so. The Node server has the same logic
(``src/processor.js``).

CONTRACT.md: "POST /webhooks/dropcowboy" (Processing).
What a customer changes: nothing; write handlers instead (``handlers.py``).
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

from .handlers import HandlerContext, run_handlers
from .providers.store.common import public_event

# First retry delay; each failure doubles it.
BACKOFF_BASE_MS = 1000

# The longest wait between two attempts.
BACKOFF_CAP_MS = 5 * 60 * 1000


def backoff_ms(failures: int) -> int:
    """How long to wait before the next attempt.

    Args:
        failures: How many attempts have failed so far (at least 1).

    Returns:
        Milliseconds: 1 s, 2 s, 4 s, and so on up to five minutes.
    """
    return min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_CAP_MS)


class Processor:
    """Runs handlers for one event and finishes it."""

    def __init__(
        self,
        config: Any,
        store: Any,
        fanout: Any,
        handlers: dict[str, Callable],
        log: Any,
        now: Callable[[], int] | None = None,
        on_event: Callable[[dict, HandlerContext], None] | None = None,
    ):
        """Creates the processor.

        Args:
            config: The loaded config (``events.max_attempts``).
            store: The event store.
            fanout: The fan-out, where finished events are published.
            handlers: The handler map from ``load_handlers()``.
            log: The redacting logger.
            now: Clock in epoch milliseconds, replaced in tests.
            on_event: Runs the modules' event handlers after yours; its failure retries the event like a handler's.
        """
        self._max_attempts = config.events.max_attempts
        self._store = store
        self._fanout = fanout
        self._handlers = handlers
        self._on_event = on_event
        self._log = log
        self._now = now or (lambda: int(time.time() * 1000))

    def process(self, event_id: str, budget_ms: int | None = None) -> dict:
        """Runs the handlers for one event and finishes it.

        Args:
            event_id: The event to process.
            budget_ms: Sets the handlers' ``signal`` after that long (inline mode); the handlers are still
                waited for to completion.

        Returns:
            ``{"outcome": ..., "error": ...}``. The outcome is ``processed``; ``retry`` (a handler failed and another
            attempt is scheduled); ``failed`` (the attempts are used up); ``skipped`` (already finished) or
            ``missing`` (no longer stored).
        """
        row = self._store.get(event_id)
        if row is None:
            return {"outcome": "missing"}
        if row["status"] != "received":
            return {"outcome": "skipped"}

        signal = threading.Event()
        timer = None
        if budget_ms:
            timer = threading.Timer(budget_ms / 1000, signal.set)
            timer.daemon = True
            timer.start()
        started = self._now()
        ctx = HandlerContext(event_id=event_id, attempt=row["attempts"] + 1, signal=signal, log=self._log)
        try:
            event = public_event(row)
            run_handlers(self._handlers, event, ctx)
            if self._on_event is not None:
                self._on_event(event, ctx)
        except Exception as err:  # noqa: BLE001 - a customer's handler may raise anything
            message = str(err) or err.__class__.__name__
            failures = self._store.note_failure(event_id, message, self._now() + backoff_ms(row["attempts"] + 1))
            self._log.error(
                "Handler failed for "
                + (row["event"] or "event")
                + " "
                + event_id
                + " (attempt "
                + str(failures)
                + " of "
                + str(self._max_attempts)
                + "):",
                message,
            )
            if failures >= self._max_attempts:
                self._store.mark_failed(event_id, message)
                self._publish(event_id)
                return {"outcome": "failed", "error": message}
            return {"outcome": "retry", "error": message}
        finally:
            if timer is not None:
                timer.cancel()
        if budget_ms and self._now() - started > budget_ms:
            self._log.warn(
                "A handler for "
                + (row["event"] or "event")
                + " "
                + event_id
                + " overran the "
                + str(budget_ms)
                + " ms inline budget: this handler is too slow for inline mode; set DC_WEBHOOKS to a queue mode."
            )
        if row["event"] == "contact.deleted" and row.get("contact_id"):
            self._store.purge_contact(row["contact_id"], event_id)
        self._store.mark_processed(event_id)
        self._publish(event_id)
        return {"outcome": "processed"}

    def _publish(self, event_id: str) -> None:
        """Sends a finished event to the browsers, without letting a fan-out outage undo the processing.

        Args:
            event_id: The finished event.
        """
        try:
            row = self._store.get(event_id)
            if row:
                self._fanout.publish(public_event(row))
        except Exception as err:  # noqa: BLE001 - the event is stored; a missed push is replayed on reconnect
            self._log.warn("Could not publish event " + event_id + " to event streams:", str(err))
