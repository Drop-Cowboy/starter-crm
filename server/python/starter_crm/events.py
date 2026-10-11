"""The in-memory event store and the ``GET /api/events`` Server-Sent Events stream.

The browser opens ``new EventSource('/api/events')`` and receives each
verified webhook as a ``message``.
"""

from __future__ import annotations

import json
import queue
import threading
from collections import OrderedDict, deque
from typing import Callable

from flask import Response, request

KEEPALIVE_SECONDS = 25

# Named, so ``onmessage`` never sees it. Tells the page that what came before
# was history and what follows is live.
REPLAYED_MESSAGE = "event: replayed\ndata: {}\n\n"


class EventStore:
    """Keeps the latest events and the ids already seen, both bounded.

    In memory, so events vanish on restart. A real CRM writes them to its own
    database or a queue before answering the webhook. Requests run on
    several threads, so every method takes the lock.
    """

    def __init__(self, max_events: int = 200, max_seen_ids: int = 1000):
        self._lock = threading.Lock()
        self._events: deque = deque(maxlen=max_events)
        self._seen: OrderedDict = OrderedDict()
        self._max_seen_ids = max_seen_ids
        self._listeners: list[Callable[[dict], None]] = []

    def has_seen(self, event_id: str) -> bool:
        with self._lock:
            return event_id in self._seen

    def add(self, event: dict) -> bool:
        """Stores ``event`` and tells every listener. Returns False, storing nothing, for an id already seen.

        Checking and storing under one lock means two deliveries of the same
        event arriving at once cannot both be stored.
        """
        with self._lock:
            if event["event_id"] in self._seen:
                return False
            self._seen[event["event_id"]] = True
            if len(self._seen) > self._max_seen_ids:
                self._seen.popitem(last=False)
            self._events.append(event)
            for listener in list(self._listeners):
                listener(event)
            return True

    def since(self, last_event_id: str | None) -> list[dict]:
        """Events after ``last_event_id``, or all of them when that id is unknown."""
        with self._lock:
            return self._since(last_event_id)

    def subscribe(self, listener: Callable[[dict], None], last_event_id: str | None = None):
        """Calls ``listener(event)`` for every event added from now on.

        Returns ``(backlog, unsubscribe)``. ``backlog`` is ``since(last_event_id)``,
        taken under the same lock as the subscription, so no event can fall
        between the replay and the live feed.
        """
        with self._lock:
            self._listeners.append(listener)
            backlog = self._since(last_event_id)

        def unsubscribe() -> None:
            with self._lock:
                if listener in self._listeners:
                    self._listeners.remove(listener)

        return backlog, unsubscribe

    def _since(self, last_event_id: str | None) -> list[dict]:
        events = list(self._events)
        for index, event in enumerate(events):
            if last_event_id and event["event_id"] == last_event_id:
                return events[index + 1 :]
        return events


def sse_message(event: dict) -> str:
    """One SSE message with the default event type, so ``onmessage`` receives it."""
    return "id: " + event["event_id"] + "\ndata: " + json.dumps(event, separators=(",", ":")) + "\n\n"


def events_view(store: EventStore) -> Callable:
    def stream_events():
        last_event_id = request.headers.get("Last-Event-ID")
        return Response(
            _stream(store, last_event_id),
            content_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return stream_events


def _stream(store: EventStore, last_event_id: str | None):
    """Yields the replay, then live events, with a keepalive comment while idle.

    Each open stream holds one server thread. When the browser goes away the
    next write fails, the generator is closed, and ``finally`` unsubscribes.
    """
    inbox: queue.Queue = queue.Queue()
    backlog, unsubscribe = store.subscribe(inbox.put, last_event_id)
    try:
        yield "retry: 3000\n\n"
        for event in backlog:
            yield sse_message(event)
        yield REPLAYED_MESSAGE
        while True:
            try:
                event = inbox.get(timeout=KEEPALIVE_SECONDS)
            except queue.Empty:
                yield ": keepalive\n\n"
                continue
            yield sse_message(event)
    finally:
        unsubscribe()
