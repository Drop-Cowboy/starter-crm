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

CONTRACT.md: GET /api/events, Shutdown.
Customers replace nothing here; to react to events on the server, write handlers (``handlers.py``).
"""

from __future__ import annotations

import json
import queue
import time
from collections import OrderedDict
from collections.abc import Callable
from typing import Any

from flask import Response, request

# How many event ids a stream remembers for de-duplication, enough to cover any replay plus its overlap.
SEEN_CAP = 1000

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
    inbox: queue.Queue = queue.Queue()
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
            if item is _SHUTDOWN:
                # Short retry so the browser reconnects after the new instance is up.
                yield "retry: 1000\n\n"
                return
            if fresh(item):
                yield sse_message(item)
    finally:
        if unsubscribe is not None:
            unsubscribe()
        if unregister is not None:
            unregister()
