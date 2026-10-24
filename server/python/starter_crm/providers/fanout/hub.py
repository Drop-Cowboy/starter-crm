"""A set of subscribers that an event is delivered to: the part every fan-out shares.

Where it sits: each fan-out (``local``, ``redis``, ``postgres``, ``poll``) differs in how
an event reaches this process, then hands it to a ``Hub``, which calls every open event
stream's handler. Streams run on their own threads, so the hub takes a lock around its
set and delivers to a copy, which lets a stream unsubscribe while a delivery is in flight.

CONTRACT.md: "Fan-out".
What a customer changes: nothing.
"""

from __future__ import annotations

import contextlib
import threading
from collections.abc import Callable


class Hub:
    """Delivers each event to every current subscriber."""

    def __init__(self) -> None:
        """Creates a hub with no subscribers."""
        self._handlers: list[Callable[[dict], None]] = []
        self._lock = threading.Lock()

    def subscribe(self, handler: Callable[[dict], None]) -> Callable[[], None]:
        """Adds a subscriber.

        Args:
            handler: Called with each event delivered from now on.

        Returns:
            A function that removes the subscriber.
        """
        with self._lock:
            self._handlers.append(handler)

        def unsubscribe() -> None:
            with self._lock:
                if handler in self._handlers:
                    self._handlers.remove(handler)

        return unsubscribe

    def deliver(self, event: dict) -> None:
        """Calls every subscriber with the event.

        One stream failing must not stop the others from receiving it, so a handler's error is dropped here:
        a stream that is closing removes itself.

        Args:
            event: The public event.
        """
        with self._lock:
            handlers = list(self._handlers)
        for handler in handlers:
            # The stream is closing; its own cleanup removes the handler.
            with contextlib.suppress(Exception):
                handler(event)

    def size(self) -> int:
        """How many subscribers are open.

        Returns:
            The count.
        """
        with self._lock:
            return len(self._handlers)
