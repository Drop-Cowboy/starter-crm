"""One suite, run against every built-in fan-out: an event published on one instance reaches every instance.

Two instances are two fan-outs on one site that share a store, which is how two servers behind a load balancer look.
"""

from __future__ import annotations

import queue
import time
import uuid
from pathlib import Path

import pytest
from helpers import make_config, silent_logger
from services import HAVE_POSTGRES, HAVE_REDIS, POSTGRES_URL, REDIS_URL, fresh_site

from starter_crm.providers import ProviderContext
from starter_crm.providers.fanout import local, poll
from starter_crm.providers.fanout import postgres as postgres_fanout
from starter_crm.providers.fanout import redis as redis_fanout
from starter_crm.providers.store import memory, postgres
from starter_crm.providers.store import redis as redis_store

STARTER_ROOT = Path(__file__).resolve().parents[3]

KINDS = [
    pytest.param("local"),
    pytest.param("poll"),
    pytest.param("redis", marks=pytest.mark.skipif(not HAVE_REDIS, reason="Valkey is not running")),
    pytest.param("postgres", marks=pytest.mark.skipif(not HAVE_POSTGRES, reason="Postgres is not running")),
]
# The store each fan-out reads from; local and poll use the memory one in these tests.
STORE_FOR = {"local": memory, "poll": memory, "redis": redis_store, "postgres": postgres}
FANOUT_FOR = {"local": local, "poll": poll, "redis": redis_fanout, "postgres": postgres_fanout}


def event_of(event_id, event="contact.msg.received"):
    return {"event_id": event_id, "event": event, "event_at": 1, "received_at": 2, "attempt": 1, "data": {}}


@pytest.fixture
def instances():
    """A builder for fan-outs on a site; every one is closed at the end."""
    made = []

    def build(kind, site, shared_store=None):
        config = make_config(
            DROPCOWBOY_SITE_ID=site,
            DC_STORE="postgres" if kind == "postgres" else ("redis" if kind == "redis" else "memory"),
            DC_FANOUT_POLL_MS="100",
            DC_DATABASE_URL=POSTGRES_URL,
            DC_REDIS_URL=REDIS_URL,
            STARTER_CRM_ROOT=str(STARTER_ROOT),
        )
        env = {"DC_DATABASE_URL": POSTGRES_URL, "DC_REDIS_URL": REDIS_URL}
        context = ProviderContext(config, env, silent_logger(), STARTER_ROOT)
        store = shared_store
        if store is None:
            store = STORE_FOR[kind].create(context)
            store.start()
            made.append(store)
        fanout = FANOUT_FOR[kind].create(ProviderContext(config, env, silent_logger(), STARTER_ROOT, store=store))
        fanout.start()
        made.append(fanout)
        return fanout, store

    yield build
    for item in reversed(made):
        item.close()


def listen(fanout, **kwargs):
    inbox = queue.Queue()
    return inbox, fanout.subscribe(inbox.put, **kwargs)


def drain(inbox, wait=3.0):
    """The next event, or None after ``wait`` seconds."""
    try:
        return inbox.get(timeout=wait)
    except queue.Empty:
        return None


@pytest.mark.parametrize("kind", KINDS)
class TestFanout:
    def test_delivers_a_published_event_to_a_subscriber_on_the_same_instance(self, kind, instances):
        fanout, store = instances(kind, fresh_site())
        inbox, _ = listen(fanout)
        event_id = str(uuid.uuid4())
        store.record(event_of(event_id))
        store.mark_processed(event_id)
        fanout.publish(event_of(event_id))
        assert drain(inbox)["event_id"] == event_id

    def test_stops_delivering_after_unsubscribe(self, kind, instances):
        fanout, store = instances(kind, fresh_site())
        inbox, unsubscribe = listen(fanout)
        unsubscribe()
        event_id = str(uuid.uuid4())
        store.record(event_of(event_id))
        store.mark_processed(event_id)
        fanout.publish(event_of(event_id))
        assert drain(inbox, 0.6) is None

    def test_reports_ready(self, kind, instances):
        fanout, _ = instances(kind, fresh_site())
        assert fanout.ready() is True

    def test_one_slow_or_failing_subscriber_does_not_stop_the_others(self, kind, instances):
        fanout, store = instances(kind, fresh_site())

        def broken(event):
            raise RuntimeError("subscriber bug")

        fanout.subscribe(broken)
        inbox, _ = listen(fanout)
        event_id = str(uuid.uuid4())
        store.record(event_of(event_id))
        store.mark_processed(event_id)
        fanout.publish(event_of(event_id))
        assert drain(inbox)["event_id"] == event_id


@pytest.mark.parametrize("kind", [p for p in KINDS if p.values[0] != "local"])
class TestFanoutAcrossInstances:
    def test_an_event_finished_on_one_instance_reaches_a_stream_on_another(self, kind, instances):
        site = fresh_site()
        first, store = instances(kind, site)
        second, _ = instances(kind, site, shared_store=store)
        inbox, _ = listen(second)
        # The poll fan-out only starts looking once a stream is open, so let the subscription settle.
        time.sleep(0.3)
        event_id = str(uuid.uuid4())
        store.record(event_of(event_id))
        store.mark_processed(event_id)
        first.publish(event_of(event_id))
        assert drain(inbox, 5)["event_id"] == event_id


@pytest.mark.parametrize("kind", [p for p in KINDS if p.values[0] in ("redis", "postgres")])
def test_two_sites_on_one_service_never_see_each_others_events(kind, instances):
    first, first_store = instances(kind, fresh_site())
    second, _ = instances(kind, fresh_site())
    inbox, _ = listen(second)
    time.sleep(0.3)
    event_id = str(uuid.uuid4())
    first_store.record(event_of(event_id))
    first_store.mark_processed(event_id)
    first.publish(event_of(event_id))
    assert drain(inbox, 1.0) is None
