"""One suite, run against every built-in data provider (memory, sqlite, and real Postgres when up).

A custom data provider should pass the same cases: they are the contract. The Node server runs the same cases in
``server/node/test/data.test.js``.
"""

from __future__ import annotations

import re
import uuid
from pathlib import Path

import pytest
from helpers import make_config, silent_logger
from services import HAVE_DYNAMODB, HAVE_POSTGRES, POSTGRES_URL, aws_test_env, fresh_site

from starter_crm.providers import ProviderContext
from starter_crm.providers.data import dynamodb, memory, postgres, sqlite

STARTER_ROOT = Path(__file__).resolve().parents[3]

PROVIDERS = {"memory": memory, "sqlite": sqlite, "postgres": postgres, "dynamodb": dynamodb}
AVAILABLE = [
    pytest.param("memory"),
    pytest.param("sqlite"),
    pytest.param("postgres", marks=pytest.mark.skipif(not HAVE_POSTGRES, reason="Postgres is not running")),
    pytest.param("dynamodb", marks=pytest.mark.skipif(not HAVE_DYNAMODB, reason="dynamodb-local is not running")),
]
DURABLE = [p for p in AVAILABLE if p.values[0] != "memory"]

ALICE = str(uuid.uuid4())
BOB = str(uuid.uuid4())
UUID_V4 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


class Clock:
    """A clock that moves forward one millisecond each time it is read."""

    def __init__(self, start):
        self.value = start

    def __call__(self):
        self.value += 1
        return self.value - 1


@pytest.fixture
def opened(tmp_path):
    """A builder for providers of one kind; every provider it made is closed at the end."""
    made = []

    def build(kind, site=None, now=None, file=None):
        config = make_config(
            DROPCOWBOY_SITE_ID=site or fresh_site(),
            DC_SQLITE_PATH=str(file or (tmp_path / (str(uuid.uuid4()) + ".sqlite"))),
            DC_DATABASE_URL=POSTGRES_URL,
            STARTER_CRM_ROOT=str(STARTER_ROOT),
            **aws_test_env(),
        )
        env = aws_test_env(DC_DATABASE_URL=POSTGRES_URL)
        data = PROVIDERS[kind].create(ProviderContext(config, env, silent_logger(), STARTER_ROOT), now)
        if hasattr(data, "start"):
            data.start()
        made.append(data)
        return data

    yield build
    for data in made:
        data.close()


@pytest.mark.parametrize("kind", AVAILABLE)
class TestDataProvider:
    def test_inserts_a_document_with_its_id_owner_and_iso_timestamps_and_reads_it_back(self, kind, opened):
        data = opened(kind, now=lambda: 1792216800123)
        deals = data.scope(ALICE).collection("deals")
        made = deals.insert({"title": "Big", "amount_cents": 500, "archived": False})
        assert UUID_V4.match(made["id"])
        assert made["owner_id"] == ALICE
        assert made["created_at"] == "2026-10-17T06:00:00.123Z"
        assert made["updated_at"] == made["created_at"]
        assert deals.get(made["id"]) == made

    def test_returns_none_for_a_missing_id_and_for_another_owners_document(self, kind, opened):
        data = opened(kind)
        made = data.scope(ALICE).collection("deals").insert({"title": "Mine"})
        assert data.scope(BOB).collection("deals").get(made["id"]) is None
        assert data.scope(ALICE).collection("deals").get(str(uuid.uuid4())) is None
        assert data.scope(ALICE).collection("deals").get("not-a-uuid") is None

    def test_never_lets_one_owner_list_update_or_remove_another_owners_documents(self, kind, opened):
        data = opened(kind)
        mine = data.scope(ALICE).collection("deals")
        theirs = data.scope(BOB).collection("deals")
        made = mine.insert({"title": "Mine"})
        assert theirs.list() == []
        assert theirs.update(made["id"], {"title": "Stolen"}) is None
        assert theirs.remove(made["id"]) is False
        assert mine.get(made["id"])["title"] == "Mine"

    def test_lets_the_system_view_see_and_change_every_owners_documents(self, kind, opened):
        data = opened(kind)
        data.scope(ALICE).collection("deals").insert({"title": "A"})
        data.scope(BOB).collection("deals").insert({"title": "B"})
        everyone = data.system().collection("deals")
        assert sorted(d["title"] for d in everyone.list()) == ["A", "B"]
        assert everyone.insert({"owner_id": ALICE, "title": "C"})["owner_id"] == ALICE
        with pytest.raises(ValueError, match="owner_id"):
            everyone.insert({"title": "no owner"})

    def test_lists_newest_first_filters_by_equality_and_honours_the_limit(self, kind, opened):
        data = opened(kind, now=Clock(1000))
        deals = data.scope(ALICE).collection("deals")
        deals.insert({"title": "one", "stage": "lead", "archived": False, "n": 1})
        deals.insert({"title": "two", "stage": "won", "archived": True, "n": 2})
        deals.insert({"title": "three", "stage": "lead", "archived": True, "n": 3})
        assert [d["title"] for d in deals.list()] == ["three", "two", "one"]
        assert [d["title"] for d in deals.list({"stage": "lead"})] == ["three", "one"]
        assert [d["title"] for d in deals.list({"stage": "lead", "archived": True})] == ["three"]
        assert [d["title"] for d in deals.list({"n": 2})] == ["two"]
        assert [d["title"] for d in deals.list(limit=2)] == ["three", "two"]

    def test_does_not_coerce_types_when_filtering(self, kind, opened):
        data = opened(kind)
        deals = data.scope(ALICE).collection("deals")
        deals.insert({"title": "a", "n": 1, "flag": True, "text": "1"})
        assert deals.list({"n": "1"}) == []
        assert deals.list({"flag": 1}) == []
        assert deals.list({"text": 1}) == []
        assert len(deals.list({"flag": True})) == 1

    def test_merges_a_patch_into_the_document_and_moves_updated_at_not_created_at(self, kind, opened):
        data = opened(kind, now=Clock(5000))
        deals = data.scope(ALICE).collection("deals")
        made = deals.insert({"title": "old", "stage": "lead"})
        changed = deals.update(made["id"], {"stage": "won"})
        assert changed["title"] == "old"
        assert changed["stage"] == "won"
        assert changed["created_at"] == made["created_at"]
        assert changed["updated_at"] != made["updated_at"]
        assert deals.update(str(uuid.uuid4()), {"stage": "x"}) is None

    def test_removes_a_document_once(self, kind, opened):
        data = opened(kind)
        deals = data.scope(ALICE).collection("deals")
        made = deals.insert({"title": "gone"})
        assert deals.remove(made["id"]) is True
        assert deals.remove(made["id"]) is False
        assert deals.get(made["id"]) is None

    def test_keeps_collections_apart(self, kind, opened):
        data = opened(kind)
        data.scope(ALICE).collection("deals").insert({"title": "d"})
        assert data.scope(ALICE).collection("tickets").list() == []

    def test_refuses_reserved_fields_bad_names_and_unsafe_filters(self, kind, opened):
        data = opened(kind)
        deals = data.scope(ALICE).collection("deals")
        with pytest.raises(ValueError):
            deals.insert({"id": "x"})
        with pytest.raises(ValueError):
            deals.insert({"owner_id": BOB})
        with pytest.raises(ValueError):
            deals.update("x", {"created_at": "x"})
        with pytest.raises(ValueError):
            deals.list({"title') OR 1=1 --": "x"})
        with pytest.raises(ValueError):
            deals.list({"nested": {"a": 1}})
        with pytest.raises(ValueError):
            data.scope(ALICE).collection("Bad-Name")
        with pytest.raises(ValueError):
            data.scope("")

    def test_stores_awkward_text_exactly(self, kind, opened):
        data = opened(kind)
        deals = data.scope(ALICE).collection("deals")
        title = 'it\'s "quoted" \\ back\nline \U0001f600 ; DROP TABLE starter_crm_data;--'
        made = deals.insert({"title": title})
        assert deals.get(made["id"])["title"] == title
        assert len(deals.list({"title": title})) == 1

    def test_reports_ready_while_it_can_reach_its_storage(self, kind, opened):
        assert opened(kind).ready() is True


def test_sqlite_opens_in_wal_mode_with_synchronous_normal_like_the_event_store(opened, monkeypatch):
    ran: list[str] = []
    connect = sqlite.sqlite3.connect

    def traced(*args, **kwargs):
        db = connect(*args, **kwargs)
        db.set_trace_callback(ran.append)
        return db

    monkeypatch.setattr(sqlite.sqlite3, "connect", traced)
    opened("sqlite").applied_migrations()
    assert "PRAGMA journal_mode = WAL" in ran
    assert "PRAGMA synchronous = NORMAL" in ran


@pytest.mark.parametrize("kind", DURABLE)
class TestDurableDataProvider:
    def test_keeps_documents_across_a_restart(self, kind, opened, tmp_path):
        site = fresh_site()
        file = tmp_path / "kept.sqlite"
        first = opened(kind, site=site, file=file)
        made = first.scope(ALICE).collection("deals").insert({"title": "kept"})
        first.close()
        second = opened(kind, site=site, file=file)
        assert second.scope(ALICE).collection("deals").get(made["id"])["title"] == "kept"

    def test_keeps_two_sites_on_one_database_apart(self, kind, opened, tmp_path):
        file = tmp_path / "shared.sqlite"
        one = opened(kind, site=fresh_site(), file=file)
        two = opened(kind, site=fresh_site(), file=file)
        made = one.scope(ALICE).collection("deals").insert({"title": "site one"})
        assert two.scope(ALICE).collection("deals").get(made["id"]) is None
        assert two.system().collection("deals").list() == []

    def test_lists_the_applied_migrations(self, kind, opened):
        if kind == "dynamodb":
            pytest.skip("a DynamoDB table has no schema to migrate")
        assert "002_module_data" in opened(kind).applied_migrations()
