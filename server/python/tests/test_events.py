from __future__ import annotations

import json

from helpers import make_client, make_config

from starter_crm.events import REPLAYED_MESSAGE, EventStore, sse_message

FIRST = {"event_id": "d1f3a8e2-7c4b-4f9a-9d22-9c1e2f3a4b5c", "event": "contact.rvm.status", "data": {}}
SECOND = {"event_id": "a9c3e8f1-4b2d-4a7c-8e9b-1c2d3e4f5a6b", "event": "contact.msg.received", "data": {}}


def first_chunks(response, count):
    """Reads ``count`` chunks of a streaming response, then closes it."""
    chunks = []
    for chunk in response.response:
        chunks.append(chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk)
        if len(chunks) == count:
            break
    response.close()
    return chunks


def test_sse_message_uses_the_default_event_type_and_the_event_id():
    message = sse_message(FIRST)
    assert message.startswith("id: " + FIRST["event_id"] + "\ndata: ")
    assert message.endswith("\n\n")
    assert "event:" not in message
    assert json.loads(message.split("data: ", 1)[1]) == FIRST


def test_stream_replays_buffered_events_oldest_first():
    store = EventStore()
    store.add(dict(FIRST))
    store.add(dict(SECOND))
    response = make_client(make_config(), store=store).get("/api/events", buffered=False)

    assert response.status_code == 200
    assert response.headers["Content-Type"] == "text/event-stream"
    assert response.headers["Cache-Control"] == "no-cache"
    assert first_chunks(response, 4) == ["retry: 3000\n\n", sse_message(FIRST), sse_message(SECOND), REPLAYED_MESSAGE]


def test_stream_replays_only_events_after_last_event_id():
    store = EventStore()
    store.add(dict(FIRST))
    store.add(dict(SECOND))
    response = make_client(make_config(), store=store).get(
        "/api/events", headers={"Last-Event-ID": FIRST["event_id"]}, buffered=False
    )
    assert first_chunks(response, 3) == ["retry: 3000\n\n", sse_message(SECOND), REPLAYED_MESSAGE]


def test_stream_ends_the_replay_with_a_named_event_even_when_empty():
    response = make_client(make_config(), store=EventStore()).get("/api/events", buffered=False)
    assert first_chunks(response, 2) == ["retry: 3000\n\n", REPLAYED_MESSAGE]
    assert REPLAYED_MESSAGE.startswith("event: replayed\n")
    assert "id:" not in REPLAYED_MESSAGE


def test_closing_the_stream_unsubscribes():
    store = EventStore()
    response = make_client(make_config(), store=store).get("/api/events", buffered=False)
    first_chunks(response, 1)
    store.add(dict(FIRST))
    assert store._listeners == []
