"""The ``poll`` fan-out: each instance asks the store what finished lately.

Where it sits: ``DC_FANOUT=poll``, which works with any durable store and needs nothing
else running. Every ``DC_FANOUT_POLL_MS`` (default 1000) a thread reads the events that
finished since the last one it saw and delivers them to the open streams, so a browser
on instance B sees what instance A finished within about a second. It only runs while a
stream is open. The overlap in the store's replay window means an event can arrive twice;
every stream de-duplicates by id.

CONTRACT.md: "Fan-out".
Env: DC_FANOUT_POLL_MS. What a customer changes: nothing.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from typing import Any

from ...problems import BootProblem
from .hub import Hub

name = "poll"
config_keys = ["DC_FANOUT_POLL_MS"]


def validate(env: Any) -> list[BootProblem]:
    """Nothing beyond the interval, which the config parser checks.

    Args:
        env: The merged environment (unused).

    Returns:
        No problems.
    """
    return []


class PollFanout:
    """A fan-out that polls the store while streams are open."""

    def __init__(self, store: Any, interval_ms: int):
        """Creates the fan-out.

        Args:
            store: The event store whose ``since()`` is polled.
            interval_ms: ``DC_FANOUT_POLL_MS``.
        """
        self._store = store
        self._interval = interval_ms / 1000
        self._hub = Hub()
        self._lock = threading.Lock()
        self._stop: threading.Event | None = None
        self._thread: threading.Thread | None = None
        self._cursor: str | None = None
        self._last_error: Exception | None = None

    def start(self) -> None:
        """Nothing to open; the thread starts with the first stream."""

    def publish(self, event: dict) -> None:
        """Delivers an event to this process's subscribers straight away.

        Args:
            event: The public event.
        """
        self._hub.deliver(event)

    def subscribe(self, handler: Callable[[dict], None], after_event_id: str | None = None) -> Callable[[], None]:
        """Adds a subscriber, starting the polling thread for the first one.

        Args:
            handler: Called with each event that finishes from now on.
            after_event_id: Where the first stream's browser left off, which the poll starts from.

        Returns:
            A function that removes the subscriber, and stops polling when none are left.
        """
        unsubscribe_hub = self._hub.subscribe(handler)
        with self._lock:
            if self._thread is None:
                # The first stream starts the clock from where its browser left off.
                self._cursor = after_event_id
                self._stop = threading.Event()
                self._thread = threading.Thread(
                    target=self._run, args=(self._stop,), name="starter-crm-fanout-poll", daemon=True
                )
                self._thread.start()

        def unsubscribe() -> None:
            unsubscribe_hub()
            with self._lock:
                if self._hub.size() == 0 and self._thread is not None:
                    self._stop.set()
                    self._thread = None

        return unsubscribe

    def ready(self) -> bool:
        """Whether the last poll succeeded.

        Returns:
            False while the store is unreachable.
        """
        return self._last_error is None

    def close(self) -> None:
        """Stops the polling thread."""
        with self._lock:
            if self._thread is not None:
                self._stop.set()
                self._thread = None

    def _run(self, stop: threading.Event) -> None:
        """The polling loop: reads what finished since the cursor and delivers it, until stopped.

        Args:
            stop: Set to end this loop.
        """
        while not stop.wait(self._interval):
            try:
                events = self._store.since(after_event_id=self._cursor)
                for event in events:
                    self._hub.deliver(event)
                if events:
                    self._cursor = events[-1]["event_id"]
                self._last_error = None
            except Exception as err:  # noqa: BLE001 - the next tick tries again; /readyz reports through ready()
                self._last_error = err


def create(ctx: Any) -> PollFanout:
    """Creates the fan-out.

    Args:
        ctx: The provider context; ``ctx.store`` is polled.

    Returns:
        The fan-out instance.
    """
    return PollFanout(ctx.store, ctx.config.events.fanout_poll_ms)
