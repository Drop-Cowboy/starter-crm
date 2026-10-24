"""Process lifecycle for graceful shutdown and readiness.

Where it sits: ``create_app()`` builds one Lifecycle; ``/readyz`` reads it;
SIGTERM in ``__main__`` (and Gunicorn's graceful timeout) closes SSE streams.

CONTRACT.md: GET /readyz, Shutdown.
Customers set ``DC_SHUTDOWN_GRACE_SECONDS``; they should not edit this file.
"""

from __future__ import annotations

import contextlib
import threading
from collections.abc import Callable
from typing import Any


class Lifecycle:
    """Tracks draining state and open SSE streams for one process."""

    def __init__(self, runtime: Any, shutdown_grace_seconds: int):
        """Creates the lifecycle in the serving state.

        Args:
            runtime: The event runtime; its ``ready()`` feeds /readyz when present.
            shutdown_grace_seconds: DC_SHUTDOWN_GRACE_SECONDS.
        """
        self._runtime = runtime
        self._shutdown_grace_seconds = shutdown_grace_seconds
        self._draining = False
        self._lock = threading.Lock()
        self._streams: list[Callable[[], None]] = []

    def is_draining(self) -> bool:
        """Whether the process is shutting down."""
        return self._draining

    @property
    def grace_seconds(self) -> int:
        """DC_SHUTDOWN_GRACE_SECONDS for this process."""
        return self._shutdown_grace_seconds

    def add_stream(self, close: Callable[[], None]) -> Callable[[], None]:
        """Register an open SSE close callback. Returns unsubscribe."""
        with self._lock:
            self._streams.append(close)

        def unsubscribe() -> None:
            with self._lock:
                if close in self._streams:
                    self._streams.remove(close)

        return unsubscribe

    def check_ready(self) -> dict:
        """Return ``{"ok": True}`` or ``{"ok": False, "reason": ...}``."""
        if self._draining:
            return {"ok": False, "reason": "draining"}
        ready = getattr(self._runtime, "ready", None)
        if callable(ready) and not ready():
            return {"ok": False, "reason": "store_not_ready"}
        return {"ok": True}

    def begin_drain(self) -> None:
        """Mark draining and close every registered SSE stream."""
        with self._lock:
            if self._draining:
                return
            self._draining = True
            closers = list(self._streams)
            self._streams.clear()
        for close in closers:
            # A hung client must not block draining the rest.
            with contextlib.suppress(Exception):
                close()
