"""The ``GET /api/events`` Server-Sent Events stream.

Where it sits: the browser opens ``EventSource('/api/events')``. The stream first replays finished
events from the store (everything after the browser's ``Last-Event-ID``, or the latest ones), sends a
named ``replayed`` event, and then forwards each event the fan-out delivers. Events reach the fan-out
after their handlers have run (``processor.py``), on this instance or any other that shares the store.
On SIGTERM, lifecycle closes every open stream with ``retry: 1000``, so the browser reconnects after the
new instance is up.

To avoid a gap, the stream subscribes to the fan-out before it replays, holds live events while the
replay is sent, and drops any event it has already sent (the replay and the live feed can overlap by a
few seconds, by design).

``DC_EVENTS_MAX_STREAM_SECONDS`` ends each stream cleanly, with ``retry: 1000``, before a host's own time
limit; the browser reconnects with ``Last-Event-ID`` and misses nothing. Each open stream holds one
server thread, so run Gunicorn with enough threads for the browsers you expect.

Every open stream sends every event, so the work grows with streams times events. Only one thread runs
Python at a time, so each event is encoded once and shared by every stream, and a stream that has fallen
behind sends what is waiting in one write instead of one write per event.

CONTRACT.md: GET /api/events, Shutdown.
Customers replace nothing here; to react to events on the server, write handlers (``handlers.py``).
"""

from __future__ import annotations

import json
import queue
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from typing import Any

from flask import Response, request

# How many event ids a stream remembers for de-duplication, enough to cover any replay plus its overlap.
SEEN_CAP = 1000

# How many encoded events are kept for the streams to share. A stream further behind than this
# encodes the event again, which costs time but changes nothing it sends.
ENCODED_CAP = 2000

# The most events a stream that has fallen behind sends in one write.
BATCH_MAX = 200

# Named, so ``onmessage`` never sees it. Tells the page that what came before was history and what
# follows is live.
REPLAYED_MESSAGE = "event: replayed\ndata: {}\n\n"

# Put into a stream's inbox to end the generator after writing retry: 1000.
_SHUTDOWN = object()


def sse_message(event: dict) -> str:
    """One SSE message with the default event type, so ``onmessage`` receives it.

    Args:
        event: The public event.

    Returns:
        The message text, ending in a blank line.
    """
    return "id: " + event["event_id"] + "\ndata: " + json.dumps(event, separators=(",", ":")) + "\n\n"


class _EncodedEvents:
    """The SSE text of recent events, shared by every stream in the process.

    The fan-out hands the same event object to every stream, so the object, not its id, is the key:
    an event replayed after a failure keeps its id but not its contents. Each entry holds the event,
    so its ``id()`` cannot be reused while the entry exists. Two streams that miss at the same moment
    both encode it, which is harmless.
    """

    def __init__(self, cap: int) -> None:
        """Creates an empty cache.

        Args:
            cap: How many events to keep; the oldest go first.
        """
        self._cap = cap
        self._texts: OrderedDict = OrderedDict()
        self._lock = threading.Lock()

    def message(self, event: dict) -> str:
        """The event's SSE message, encoded at most once while it stays in the cache.

        Args:
            event: The public event.

        Returns:
            The same text as ``sse_message(event)``.
        """
        key = id(event)
        with self._lock:
            entry = self._texts.get(key)
        if entry is not None and entry[0] is event:
            return entry[1]
        text = sse_message(event)
        with self._lock:
            self._texts[key] = (event, text)
            if len(self._texts) > self._cap:
                self._texts.popitem(last=False)
        return text


_encoded = _EncodedEvents(ENCODED_CAP)


def events_view(runtime: Any, lifecycle: Any = None) -> Callable:
    """Builds the GET /api/events view.

    Args:
        runtime: The event runtime; its store gives the replay and its fan-out the live events.
        lifecycle: Optional drain controller that closes the stream on shutdown.

    Returns:
        A Flask view that streams Server-Sent Events.
    """
    max_stream_seconds = runtime.config.events.max_stream_seconds
    keepalive_seconds = runtime.config.events.keepalive_seconds

    def stream_events():
        last_event_id = request.headers.get("Last-Event-ID") or None
        return Response(
            _stream(runtime.store, runtime.fanout, last_event_id, lifecycle, max_stream_seconds, keepalive_seconds),
            content_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return stream_events


def _stream(
    store: Any,
    fanout: Any,
    last_event_id: str | None,
    lifecycle: Any,
    max_stream_seconds: int,
    keepalive_seconds: int = 25,
):
    """Yields the replay, then live events, with a keepalive comment while idle.

    Each open stream holds one server thread. When the browser goes away the next write fails, the
    generator is closed, and ``finally`` unsubscribes. On process drain, lifecycle puts ``_SHUTDOWN`` so we
    send ``retry: 1000`` and end cleanly.

    Args:
        store: Where the replay comes from.
        fanout: Where live events come from.
        last_event_id: The browser's ``Last-Event-ID``, if any.
        lifecycle: The drain controller, or None.
        max_stream_seconds: ``DC_EVENTS_MAX_STREAM_SECONDS``; 0 means no cap.
        keepalive_seconds: How often an idle stream sends ``: keepalive`` (see config.py).

    Yields:
        SSE text chunks.
    """
    inbox: queue.SimpleQueue = queue.SimpleQueue()
    # The browser already has its Last-Event-ID event, so a fan-out that repeats it is not forwarded.
    seen: OrderedDict = OrderedDict([(last_event_id, True)] if last_event_id else [])
    unregister = None
    unsubscribe = None

    def fresh(event: dict) -> bool:
        """Whether this stream has not sent the event yet; remembers it."""
        if event["event_id"] in seen:
            return False
        seen[event["event_id"]] = True
        if len(seen) > SEEN_CAP:
            seen.popitem(last=False)
        return True

    try:
        # Subscribe first, so an event that finishes during the replay waits in the inbox instead of being missed.
        unsubscribe = fanout.subscribe(inbox.put, after_event_id=last_event_id)
        if lifecycle is not None:
            unregister = lifecycle.add_stream(lambda: inbox.put(_SHUTDOWN))
        yield "retry: 3000\n\n"
        try:
            backlog = store.since(after_event_id=last_event_id)
        except Exception:  # noqa: BLE001 - the store is down: tell the browser to try again shortly
            yield "retry: 1000\n\n"
            return
        for event in backlog:
            if fresh(event):
                yield sse_message(event)
        yield REPLAYED_MESSAGE
        deadline = time.monotonic() + max_stream_seconds if max_stream_seconds > 0 else None
        while True:
            wait = keepalive_seconds
            if deadline is not None:
                wait = min(wait, deadline - time.monotonic())
                if wait <= 0:
                    yield "retry: 1000\n\n"
                    return
            try:
                item = inbox.get(timeout=wait)
            except queue.Empty:
                if deadline is None or time.monotonic() < deadline:
                    yield ": keepalive\n\n"
                continue
            batch, shutdown = _drain(inbox, item, fresh)
            if batch:
                yield batch
            if shutdown:
                # Short retry so the browser reconnects after the new instance is up.
                yield "retry: 1000\n\n"
                return
    finally:
        if unsubscribe is not None:
            unsubscribe()
        if unregister is not None:
            unregister()


def _drain(inbox: queue.SimpleQueue, first: Any, fresh: Callable[[dict], bool]) -> tuple[str, bool]:
    """Collects the first item and whatever else is already waiting into one write.

    Args:
        inbox: The stream's inbox.
        first: The item just taken from it.
        fresh: Whether the stream has not sent an event yet; remembers it.

    Returns:
        The messages to send, joined (empty when every event was a repeat), and whether a shutdown
        was found. Nothing after a shutdown is taken.
    """
    messages = []
    item = first
    while True:
        if item is _SHUTDOWN:
            return "".join(messages), True
        if fresh(item):
            messages.append(_encoded.message(item))
            if len(messages) >= BATCH_MAX:
                break
        try:
            item = inbox.get_nowait()
        except queue.Empty:
            break
    return "".join(messages), False
