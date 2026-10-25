"""One suite, run against every built-in event store (memory, sqlite, and real Postgres and Valkey when up).

A custom store should pass the same cases: they are the store contract. The Node server runs the same cases in
``server/node/test/stores.test.js``.
"""

from __future__ import annotations

import concurrent.futures
import uuid
from pathlib import Path

import pytest
from helpers import make_config, silent_logger
from services import (
    HAVE_DYNAMODB,
    HAVE_POSTGRES,
    HAVE_REDIS,
    HAVE_REDIS_CLUSTER,
    POSTGRES_URL,
    REDIS_CLUSTER_URL,
    REDIS_URL,
    aws_test_env,
    fresh_site,
)

from starter_crm.providers import ProviderContext
from starter_crm.providers.store import dynamodb, memory, postgres, sqlite
from starter_crm.providers.store import redis as redis_store

STARTER_ROOT = Path(__file__).resolve().parents[3]

PROVIDERS = {
    "memory": memory,
    "sqlite": sqlite,
    "postgres": postgres,
    "redis": redis_store,
    "redis-cluster": redis_store,
    "dynamodb": dynamodb,
}
AVAILABLE = [
    pytest.param("memory"),
    pytest.param("sqlite"),
    pytest.param("postgres", marks=pytest.mark.skipif(not HAVE_POSTGRES, reason="Postgres is not running")),
    pytest.param("redis", marks=pytest.mark.skipif(not HAVE_REDIS, reason="Valkey is not running")),
    pytest.param(
        "redis-cluster", marks=pytest.mark.skipif(not HAVE_REDIS_CLUSTER, reason="Valkey cluster is not running")
    ),
    pytest.param("dynamodb", marks=pytest.mark.skipif(not HAVE_DYNAMODB, reason="dynamodb-local is not running")),
]
DURABLE = [p for p in AVAILABLE if p.values[0] != "memory"]


class Clock:
    """A clock the test moves by hand."""

    def __init__(self, start):
        self.value = start

    def __call__(self):
        return self.value


@pytest.fixture
def opened(tmp_path):
    """A builder for stores of one kind; every store it made is closed at the end."""
    made = []

    def build(kind, site=None, now=None, retention_hours=72, file=None):
        config = make_config(
            DROPCOWBOY_SITE_ID=site or fresh_site(),
            DC_STORE="redis" if kind == "redis-cluster" else kind,
            DC_SQLITE_PATH=str(file or (tmp_path / (str(uuid.uuid4()) + ".sqlite"))),
            DC_EVENT_RETENTION_HOURS=str(retention_hours),
            DC_DATABASE_URL=POSTGRES_URL,
            DC_REDIS_URL=REDIS_URL,
            STARTER_CRM_ROOT=str(STARTER_ROOT),
            **aws_test_env(),
        )
        env = aws_test_env(DC_DATABASE_URL=POSTGRES_URL, DC_REDIS_URL=REDIS_URL)
        if kind == "redis-cluster":
            env.update(DC_REDIS_URL=REDIS_CLUSTER_URL, DC_REDIS_CLUSTER="on")
        store = PROVIDERS[kind].create(ProviderContext(config, env, silent_logger(), STARTER_ROOT), now)
        store.start()
        made.append(store)
        return store

    yield build
    for store in made:
        store.close()


def event(event_id, **extra):
    base = {
        "event_id": event_id,
        "event": "contact.msg.received",
        "event_at": 1,
        "received_at": 2,
        "attempt": 1,
        "data": {"contact_id": "c-1", "n": 1},
    }
    base.update(extra)
    return base


def new_id():
    return str(uuid.uuid4())


def ids(events):
    return [e["event_id"] for e in events]


@pytest.mark.parametrize("kind", AVAILABLE)
class TestEventStore:
    def test_records_an_event_once_and_reports_the_status_of_a_duplicate(self, kind, opened):
        store = opened(kind)
        event_id = new_id()
        assert store.record(event(event_id)) == {"inserted": True, "status": "received"}
        assert store.record(event(event_id)) == {"inserted": False, "status": "received"}
        store.mark_processed(event_id)
        assert store.record(event(event_id)) == {"inserted": False, "status": "processed"}

    def test_inserts_once_when_many_instances_record_the_same_id_at_the_same_moment(self, kind, opened):
        store = opened(kind)
        event_id = new_id()
        with concurrent.futures.ThreadPoolExecutor(12) as pool:
            results = list(pool.map(lambda _: store.record(event(event_id)), range(12)))
        assert len([r for r in results if r["inserted"]]) == 1

    def test_gets_an_event_with_its_status_and_none_for_an_unknown_one(self, kind, opened):
        store = opened(kind)
        event_id = new_id()
        store.record(event(event_id))
        row = store.get(event_id)
        assert (row["event_id"], row["event"], row["status"], row["attempts"]) == (
            event_id,
            "contact.msg.received",
            "received",
            0,
        )
        assert row["data"] == {"contact_id": "c-1", "n": 1}
        assert store.get(new_id()) is None

    def test_replays_only_finished_events_oldest_first_from_a_cursor_or_from_the_latest(self, kind, opened):
        clock = Clock(1_000_000)
        store = opened(kind, now=clock)
        order = []
        for n in range(5):
            event_id = new_id()
            order.append(event_id)
            store.record(event(event_id, data={"n": n}))
            clock.value += 10_000
            store.mark_processed(event_id)
        store.record(event(new_id()))
        everything = store.since()
        assert ids(everything) == order
        assert everything[0] == {
            "event_id": order[0],
            "event": "contact.msg.received",
            "event_at": 1,
            "received_at": 2,
            "attempt": 1,
            "data": {"n": 0},
        }
        assert ids(store.since(after_event_id=order[2])) == [order[3], order[4]]
        assert ids(store.since(after_event_id=new_id())) == order
        assert ids(store.since(limit=2)) == [order[3], order[4]]

    def test_overlaps_a_cursor_by_five_seconds_so_late_finishers_are_not_lost(self, kind, opened):
        clock = Clock(5_000_000)
        store = opened(kind, now=clock)
        first, second = new_id(), new_id()
        store.record(event(first))
        store.record(event(second))
        clock.value += 100
        store.mark_processed(second)
        clock.value += 100
        store.mark_processed(first)
        assert ids(store.since(after_event_id=first)) == [second]

    def test_hands_each_due_event_to_one_claimant_until_the_lease_ends(self, kind, opened):
        clock = Clock(2_000_000)
        store = opened(kind, now=clock)
        due, later = new_id(), new_id()
        store.record(event(due))
        store.record(event(later), visible_at=clock.value + 120_000)
        assert ids(store.pending(limit=5, lease_ms=30_000)) == [due]
        assert store.pending(limit=5, lease_ms=30_000) == []
        clock.value += 31_000
        assert ids(store.pending(limit=5, lease_ms=30_000)) == [due]
        clock.value += 120_000
        assert sorted(ids(store.pending(limit=5, lease_ms=30_000))) == sorted([due, later])

    def test_does_not_give_the_same_due_event_to_two_workers_asking_at_once(self, kind, opened):
        store = opened(kind)
        wanted = []
        for _ in range(6):
            event_id = new_id()
            wanted.append(event_id)
            store.record(event(event_id))
        with concurrent.futures.ThreadPoolExecutor(3) as pool:
            claims = list(pool.map(lambda _: store.pending(limit=6, lease_ms=60_000), range(3)))
        flat = [i for claim in claims for i in ids(claim)]
        assert len(set(flat)) == len(flat)
        assert sorted(flat) == sorted(wanted)

    def test_counts_failures_fails_an_event_for_good_lists_it_and_replays_it(self, kind, opened):
        clock = Clock(3_000_000)
        store = opened(kind, now=clock)
        event_id = new_id()
        store.record(event(event_id))
        assert store.note_failure(event_id, "boom", clock.value + 1000) == 1
        assert store.note_failure(event_id, "boom again", clock.value + 2000) == 2
        row = store.get(event_id)
        assert (row["attempts"], row["last_error"], row["status"]) == (2, "boom again", "received")
        store.mark_failed(event_id, "gave up")
        row = store.get(event_id)
        assert (row["status"], row["last_error"]) == ("failed", "gave up")
        assert ids(store.list_failed()) == [event_id]
        # A failed event is finished, so the browser sees it, and a duplicate delivery does not revive it.
        assert ids(store.since()) == [event_id]
        assert store.record(event(event_id)) == {"inserted": False, "status": "failed"}
        assert store.replay(event_id) is True
        row = store.get(event_id)
        assert (row["status"], row["attempts"], row["done_at"]) == ("received", 0, None)
        assert store.list_failed() == []
        assert store.replay(event_id) is False
        assert ids(store.pending(limit=5)) == [event_id]

    def test_purges_every_event_about_a_contact_except_the_deletion(self, kind, opened):
        store = opened(kind)
        old, other, deletion = new_id(), new_id(), new_id()
        store.record(event(old, data={"contact_id": "gone", "phone": "+13125550142"}))
        store.record(event(other, data={"contact_id": "stays"}))
        store.record(event(deletion, event="contact.deleted", data={"contact_id": "gone", "phone": "+13125550142"}))
        store.mark_processed(old)
        store.mark_processed(other)
        assert store.purge_contact("gone", deletion) == 1
        assert store.get(old) is None
        assert store.get(other) is not None
        assert store.get(deletion)["data"] == {"contact_id": "gone"}

    def test_prunes_finished_events_past_the_retention_window_and_keeps_the_rest(self, kind, opened):
        import time

        clock = Clock(int(time.time() * 1000))
        store = opened(kind, now=clock, retention_hours=1)
        old, recent, waiting = new_id(), new_id(), new_id()
        store.record(event(old))
        store.mark_processed(old)
        clock.value += 2 * 3600 * 1000
        store.record(event(recent))
        store.mark_processed(recent)
        store.record(event(waiting))
        store.prune()
        assert ids(store.since()) == [recent]
        assert store.get(waiting) is not None

    def test_counts_events_by_status_and_reports_how_long_the_oldest_has_waited(self, kind, opened):
        clock = Clock(10_000_000)
        store = opened(kind, now=clock)
        done, waiting = new_id(), new_id()
        store.record(event(done, received_at=clock.value))
        store.mark_processed(done)
        store.record(event(waiting, received_at=clock.value))
        clock.value += 90_000
        assert store.counts() == {"received": 1, "processed": 1, "failed": 0, "oldest_received_age_seconds": 90}

    def test_reports_ready_while_it_can_reach_its_storage(self, kind, opened):
        assert opened(kind).ready() is True


@pytest.mark.parametrize("kind", [p for p in AVAILABLE if p.values[0] != "memory"])
def test_keeps_two_sites_on_one_store_apart(kind, opened, tmp_path):
    file = tmp_path / "shared.sqlite"
    a = opened(kind, site=fresh_site(), file=file)
    b = opened(kind, site=fresh_site(), file=file)
    event_id = new_id()
    a.record(event(event_id))
    a.mark_processed(event_id)
    assert b.get(event_id) is None
    assert b.since() == []
    assert b.pending(limit=5) == []
    assert ids(a.since()) == [event_id]


def test_sqlite_opens_in_wal_mode_with_synchronous_normal_so_a_commit_does_not_wait_for_the_disk(opened, monkeypatch):
    ran: list[str] = []
    connect = sqlite.sqlite3.connect

    def traced(*args, **kwargs):
        db = connect(*args, **kwargs)
        db.set_trace_callback(ran.append)
        return db

    monkeypatch.setattr(sqlite.sqlite3, "connect", traced)
    opened("sqlite")
    assert "PRAGMA journal_mode = WAL" in ran
    assert "PRAGMA synchronous = NORMAL" in ran


@pytest.mark.parametrize("kind", DURABLE)
def test_keeps_its_events_across_a_restart(kind, opened, tmp_path):
    site, file = fresh_site(), tmp_path / "restart.sqlite"
    first = opened(kind, site=site, file=file)
    event_id = new_id()
    first.record(event(event_id))
    first.mark_processed(event_id)
    first.close()
    second = opened(kind, site=site, file=file)
    assert ids(second.since()) == [event_id]
