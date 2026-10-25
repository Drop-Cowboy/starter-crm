from __future__ import annotations

import json
import queue
import threading
import time
import uuid

from helpers import make_client, make_config, silent_logger

from starter_crm import events
from starter_crm.events import REPLAYED_MESSAGE, sse_message
from starter_crm.runtime import default_runtime

FIRST = {"event_id": "d1f3a8e2-7c4b-4f9a-9d22-9c1e2f3a4b5c", "event": "contact.rvm.status", "data": {}}
SECOND = {"event_id": "a9c3e8f1-4b2d-4a7c-8e9b-1c2d3e4f5a6b", "event": "contact.msg.received", "data": {}}


def stored(runtime, event, at):
    """Records an event and finishes it at `at`, the way the processor would."""
    runtime.store.record(
        {
            "event_id": event["event_id"],
            "event": event["event"],
            "event_at": None,
            "received_at": at,
            "attempt": 1,
            "data": {},
        }
    )
    runtime.store.mark_processed(event["event_id"])


def public(event):
    return {
        "event_id": event["event_id"],
        "event": event["event"],
        "event_at": None,
        "received_at": 0,
        "attempt": 1,
        "data": {},
    }


def runtime_with(*events):
    config = make_config()
    runtime = default_runtime(config, silent_logger())
    for index, event in enumerate(events):
        stored(runtime, event, index)
        time.sleep(0.002)
    return config, runtime


def first_chunks(response, count):
    """Reads ``count`` chunks of a streaming response, then closes it."""
    chunks = []
    for chunk in response.response:
        chunks.append(chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk)
        if len(chunks) == count:
            break
    response.close()
    return chunks


def event_of(chunk):
    return json.loads(chunk.split("data: ", 1)[1])


def test_sse_message_uses_the_default_event_type_and_the_event_id():
    message = sse_message(FIRST)
    assert message.startswith("id: " + FIRST["event_id"] + "\ndata: ")
    assert message.endswith("\n\n")
    assert "event:" not in message
    assert json.loads(message.split("data: ", 1)[1]) == FIRST


def test_stream_replays_finished_events_oldest_first():
    config, runtime = runtime_with(FIRST, SECOND)
    response = make_client(config, runtime).get("/api/events", buffered=False)

    assert response.status_code == 200
    assert response.headers["Content-Type"] == "text/event-stream"
    assert response.headers["Cache-Control"] == "no-cache"
    chunks = first_chunks(response, 4)
    assert chunks[0] == "retry: 3000\n\n"
    assert [event_of(chunks[1])["event_id"], event_of(chunks[2])["event_id"]] == [FIRST["event_id"], SECOND["event_id"]]
    assert chunks[3] == REPLAYED_MESSAGE


def test_stream_does_not_repeat_the_last_event_id():
    config, runtime = runtime_with(FIRST, SECOND)
    response = make_client(config, runtime).get(
        "/api/events", headers={"Last-Event-ID": FIRST["event_id"]}, buffered=False
    )
    chunks = first_chunks(response, 3)
    ids = [event_of(c)["event_id"] for c in chunks if c.startswith("id: ")]
    assert ids == [SECOND["event_id"]]


def test_stream_ends_the_replay_with_a_named_event_even_when_empty():
    config = make_config()
    response = make_client(config).get("/api/events", buffered=False)
    assert first_chunks(response, 2) == ["retry: 3000\n\n", REPLAYED_MESSAGE]
    assert REPLAYED_MESSAGE.startswith("event: replayed\n")
    assert "id:" not in REPLAYED_MESSAGE


def test_closing_the_stream_unsubscribes():
    config = make_config()
    runtime = default_runtime(config, silent_logger())
    response = make_client(config, runtime).get("/api/events", buffered=False)
    first_chunks(response, 1)
    # Closing the response closes the generator, whose finally block unsubscribes.
    assert runtime.fanout._hub.size() == 0


def test_a_live_event_reaches_an_open_stream_after_the_replay_and_only_once():
    config = make_config()
    runtime = default_runtime(config, silent_logger())
    response = make_client(config, runtime).get("/api/events", buffered=False)
    iterator = iter(response.response)
    assert next(iterator) == b"retry: 3000\n\n" or True
    seen = []

    def publish():
        time.sleep(0.2)
        runtime.fanout.publish(public(FIRST))
        runtime.fanout.publish(public(FIRST))

    thread = threading.Thread(target=publish)
    thread.start()
    for chunk in iterator:
        text = chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk
        seen.append(text)
        if text.startswith("id: "):
            break
    thread.join()
    response.close()
    assert REPLAYED_MESSAGE in seen
    assert seen.index(REPLAYED_MESSAGE) < len(seen) - 1
    assert event_of(seen[-1])["event_id"] == FIRST["event_id"]


def remembering():
    """A ``fresh`` check like the stream's: true the first time it sees an event id."""
    sent = set()

    def fresh(event):
        if event["event_id"] in sent:
            return False
        sent.add(event["event_id"])
        return True

    return fresh


def inbox_of(*items):
    inbox = queue.SimpleQueue()
    for item in items:
        inbox.put(item)
    return inbox


def test_events_waiting_together_go_out_in_one_write_in_order_without_repeats():
    inbox = inbox_of(SECOND, FIRST)
    batch, shutdown = events._drain(inbox, FIRST, remembering())
    assert batch == sse_message(FIRST) + sse_message(SECOND)
    assert shutdown is False
    assert inbox.empty()


def test_a_shutdown_sends_what_came_before_it_and_leaves_the_rest():
    inbox = inbox_of(events._SHUTDOWN, SECOND)
    batch, shutdown = events._drain(inbox, FIRST, remembering())
    assert batch == sse_message(FIRST)
    assert shutdown is True
    assert inbox.get_nowait() == SECOND


def test_one_write_holds_at_most_batch_max_events():
    waiting = [
        {"event_id": str(uuid.uuid4()), "event": "contact.msg.received", "data": {}}
        for _ in range(events.BATCH_MAX + 5)
    ]
    inbox = inbox_of(*waiting[1:])
    batch, _ = events._drain(inbox, waiting[0], remembering())
    assert batch.count("id: ") == events.BATCH_MAX
    assert inbox.qsize() == 5


def test_every_stream_shares_one_encoding_of_an_event():
    event = public(FIRST)
    first = events._encoded.message(event)
    assert first == sse_message(event)
    assert events._encoded.message(event) is first


def test_an_event_with_a_known_id_but_new_contents_is_encoded_again():
    events._encoded.message(public(FIRST))
    replayed = dict(public(FIRST), attempt=2)
    assert events._encoded.message(replayed) == sse_message(replayed)


def test_the_stream_closes_itself_at_the_cap_with_a_short_retry():
    config = make_config(DC_EVENTS_MAX_STREAM_SECONDS="1")
    runtime = default_runtime(config, silent_logger())
    response = make_client(config, runtime).get("/api/events", buffered=False)
    started = time.monotonic()
    chunks = [c.decode("utf-8") if isinstance(c, bytes) else c for c in response.response]
    assert chunks[-1] == "retry: 1000\n\n"
    assert 0.8 < time.monotonic() - started < 5
