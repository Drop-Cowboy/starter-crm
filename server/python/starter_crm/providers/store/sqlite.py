"""The ``sqlite`` event store: one file on disk, no server to run.

Where it sits: ``DC_STORE=sqlite``, with the file at ``DC_SQLITE_PATH`` (default
``data/starter-crm.sqlite`` under the starter root). Events survive a restart, which
makes this the simplest durable store for a single instance on a VPS or a Compose host.
It uses the standard library's ``sqlite3`` with the write-ahead log on, so reads never
block the writer. The Node server reads and writes the same file format.

SQLite allows one writer at a time and cannot be shared across machines, so run one
instance. A second process on the same file works (the busy timeout makes it wait its
turn), which is how the multi-instance tests exercise it, but it is not a way to scale
out; use ``postgres`` for that. The file is opened in ``start()``, not at import or
creation, because a connection must never be carried across Gunicorn's fork.

CONTRACT.md: "Event store".
Env: DC_SQLITE_PATH. What a customer changes: nothing.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ...migrations import migrate_sqlite
from ...problems import BootProblem
from .common import (
    DEFAULT_LEASE_MS,
    FAILED,
    PROCESSED,
    RECEIVED,
    REPLAY_OVERLAP_MS,
    contact_id_of,
    public_event,
    replay_limit,
    retention_ms,
    site_key,
)

name = "sqlite"
config_keys = ["DC_SQLITE_PATH"]


def validate(env: Any) -> list[BootProblem]:
    """Nothing beyond the path, which has a default; the folder is created at start.

    Args:
        env: The merged environment (unused).

    Returns:
        No problems.
    """
    return []


def _from_row(row: sqlite3.Row | None) -> dict | None:
    """Turns a database row into an event dict, with the JSON ``data`` parsed.

    Args:
        row: A row from the events table, or None.

    Returns:
        The event, or None for no row.
    """
    if row is None:
        return None
    return {
        "event_id": row["event_id"],
        "event": row["event"],
        "event_at": row["event_at"],
        "received_at": row["received_at"],
        "attempt": row["attempt"],
        "data": json.loads(row["data"]),
        "contact_id": row["contact_id"],
        "status": row["status"],
        "attempts": row["attempts"],
        "next_attempt_at": row["next_attempt_at"],
        "last_error": row["last_error"],
        "done_at": row["done_at"],
    }


class SqliteStore:
    """An event store in one SQLite file. One connection, guarded by a lock."""

    def __init__(self, config: Any, now: Callable[[], int] | None = None):
        """Prepares the store; nothing is opened until ``start()``.

        Args:
            config: The loaded config (site id, root, SQLite path, retention).
            now: Clock in epoch milliseconds, replaced in tests.
        """
        self._now = now or (lambda: int(time.time() * 1000))
        self._site = site_key(config)
        self._keep_ms = retention_ms(config)
        self._root = Path(config.root)
        self._file = (self._root / config.events.sqlite_path).resolve()
        self._lock = threading.RLock()
        self._db: sqlite3.Connection | None = None

    def start(self) -> None:
        """Creates the folder, opens the file and applies migrations. Safe to call twice."""
        with self._lock:
            if self._db is not None:
                return
            self._file.parent.mkdir(parents=True, exist_ok=True)
            # isolation_level=None: autocommit, so the transactions below are explicit and visible.
            db = sqlite3.connect(self._file, isolation_level=None, check_same_thread=False, timeout=5)
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA journal_mode = WAL")
            db.execute("PRAGMA busy_timeout = 5000")
            migrate_sqlite(db)
            self._db = db

    def _conn(self) -> sqlite3.Connection:
        """The open connection.

        Returns:
            The connection.

        Raises:
            RuntimeError: When ``start()`` has not run.
        """
        if self._db is None:
            raise RuntimeError("the sqlite event store is not started")
        return self._db

    def record(self, event: dict, visible_at: int | None = None) -> dict:
        """Stores a new event as ``received``, unless its id is already stored.

        Args:
            event: ``event_id``, ``event``, ``event_at``, ``received_at``, ``attempt`` and ``data``.
            visible_at: When the outbox may first pick the event up (epoch ms); now by default.

        Returns:
            ``{"inserted": bool, "status": str}``.
        """
        with self._lock:
            cursor = self._conn().execute(
                "INSERT INTO starter_crm_events (site_id, event_id, event, event_at, received_at, attempt, contact_id, "
                "data, status, attempts, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) "
                "ON CONFLICT (site_id, event_id) DO NOTHING",
                (
                    self._site,
                    event["event_id"],
                    event["event"],
                    event["event_at"],
                    event["received_at"],
                    event["attempt"],
                    contact_id_of(event["data"]),
                    json.dumps(event["data"], separators=(",", ":")),
                    RECEIVED,
                    visible_at if visible_at is not None else self._now(),
                ),
            )
            if cursor.rowcount == 1:
                return {"inserted": True, "status": RECEIVED}
            existing = self.get(event["event_id"])
            return {"inserted": False, "status": existing["status"] if existing else RECEIVED}

    def get(self, event_id: str) -> dict | None:
        """Reads one event.

        Args:
            event_id: The event id.

        Returns:
            The stored event, or None.
        """
        with self._lock:
            row = (
                self._conn()
                .execute("SELECT * FROM starter_crm_events WHERE site_id = ? AND event_id = ?", (self._site, event_id))
                .fetchone()
            )
            return _from_row(row)

    def mark_processed(self, event_id: str) -> None:
        """Marks an event processed.

        Args:
            event_id: The event id.
        """
        self._finish(event_id, PROCESSED, None)

    def mark_failed(self, event_id: str, error: str) -> None:
        """Marks an event failed after its attempts are used up.

        Args:
            event_id: The event id.
            error: The last error text.
        """
        self._finish(event_id, FAILED, str(error))

    def note_failure(self, event_id: str, error: str, next_attempt_at: int) -> int:
        """Counts a failed handler run and schedules the next attempt.

        Args:
            event_id: The event id.
            error: The error text.
            next_attempt_at: When the outbox may try again (epoch ms).

        Returns:
            How many runs have failed so far, 0 when the event is gone.
        """
        with self._lock:
            db = self._conn()
            db.execute(
                "UPDATE starter_crm_events SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? "
                "WHERE site_id = ? AND event_id = ?",
                (str(error), next_attempt_at, self._site, event_id),
            )
            row = db.execute(
                "SELECT attempts FROM starter_crm_events WHERE site_id = ? AND event_id = ?", (self._site, event_id)
            ).fetchone()
            return row["attempts"] if row else 0

    def since(self, after_event_id: str | None = None, limit: int | None = None) -> list[dict]:
        """Finished events after a cursor, oldest first.

        Args:
            after_event_id: The last event the caller saw. Unknown (or unfinished) ids return the latest events.
            limit: At most this many, capped at 200.

        Returns:
            Public events, replaying from ``REPLAY_OVERLAP_MS`` before the cursor's finish time.
        """
        with self._lock:
            db = self._conn()
            start = -1
            if after_event_id:
                cursor = db.execute(
                    "SELECT done_at FROM starter_crm_events WHERE site_id = ? AND event_id = ?",
                    (self._site, after_event_id),
                ).fetchone()
                if cursor is not None and cursor["done_at"] is not None:
                    start = cursor["done_at"] - REPLAY_OVERLAP_MS
            rows = db.execute(
                "SELECT * FROM starter_crm_events WHERE site_id = ? AND done_at IS NOT NULL AND done_at >= ? "
                "AND event_id <> ? ORDER BY done_at DESC, event_id DESC LIMIT ?",
                (self._site, start, after_event_id or "", replay_limit(limit)),
            ).fetchall()
            return [public_event(_from_row(row)) for row in reversed(rows)]

    def pending(self, limit: int = 10, lease_ms: int = DEFAULT_LEASE_MS) -> list[dict]:
        """Claims received events that are due, leasing them so no other worker takes them.

        Args:
            limit: How many to claim.
            lease_ms: How long the claim lasts.

        Returns:
            The claimed events.
        """
        with self._lock:
            db = self._conn()
            # One writer at a time, so selecting then leasing inside a transaction cannot hand an event to two workers.
            db.execute("BEGIN IMMEDIATE")
            try:
                at = self._now()
                rows = db.execute(
                    "SELECT * FROM starter_crm_events WHERE site_id = ? AND status = 'received' "
                    "AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?",
                    (self._site, at, limit),
                ).fetchall()
                for row in rows:
                    db.execute(
                        "UPDATE starter_crm_events SET next_attempt_at = ? WHERE site_id = ? AND event_id = ?",
                        (at + lease_ms, self._site, row["event_id"]),
                    )
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise
            return [_from_row(row) for row in rows]

    def list_failed(self, limit: int = 50) -> list[dict]:
        """Failed events, newest first.

        Args:
            limit: At most this many.

        Returns:
            The failed events.
        """
        with self._lock:
            rows = (
                self._conn()
                .execute(
                    "SELECT * FROM starter_crm_events WHERE site_id = ? AND status = 'failed' "
                    "ORDER BY done_at DESC LIMIT ?",
                    (self._site, limit),
                )
                .fetchall()
            )
            return [_from_row(row) for row in rows]

    def replay(self, event_id: str) -> bool:
        """Puts a failed event back to ``received`` so its handlers run again.

        Args:
            event_id: The event id.

        Returns:
            True when the event was failed and is queued again.
        """
        with self._lock:
            cursor = self._conn().execute(
                "UPDATE starter_crm_events SET status = 'received', attempts = 0, done_at = NULL, next_attempt_at = ? "
                "WHERE site_id = ? AND event_id = ? AND status = 'failed'",
                (self._now(), self._site, event_id),
            )
            return cursor.rowcount == 1

    def purge_contact(self, contact_id: str, keep_event_id: str | None = None) -> int:
        """Deletes every stored event about a contact, and scrubs the one that triggered the purge.

        Args:
            contact_id: The contact.
            keep_event_id: The ``contact.deleted`` event itself, kept with its data reduced to the contact id.

        Returns:
            How many events were deleted.
        """
        with self._lock:
            db = self._conn()
            removed = db.execute(
                "DELETE FROM starter_crm_events WHERE site_id = ? AND contact_id = ? AND event_id <> ?",
                (self._site, contact_id, keep_event_id or ""),
            ).rowcount
            if keep_event_id:
                db.execute(
                    "UPDATE starter_crm_events SET data = ? WHERE site_id = ? AND event_id = ?",
                    (json.dumps({"contact_id": contact_id}, separators=(",", ":")), self._site, keep_event_id),
                )
            return removed

    def counts(self) -> dict:
        """Counts events by status.

        Returns:
            ``received``, ``processed``, ``failed`` and ``oldest_received_age_seconds``.
        """
        with self._lock:
            db = self._conn()
            out = {RECEIVED: 0, PROCESSED: 0, FAILED: 0, "oldest_received_age_seconds": 0}
            for row in db.execute(
                "SELECT status, COUNT(*) AS n FROM starter_crm_events WHERE site_id = ? GROUP BY status", (self._site,)
            ):
                out[row["status"]] = row["n"]
            oldest = db.execute(
                "SELECT MIN(received_at) AS at FROM starter_crm_events WHERE site_id = ? AND status = 'received'",
                (self._site,),
            ).fetchone()
            if oldest is not None and oldest["at"] is not None:
                out["oldest_received_age_seconds"] = round((self._now() - oldest["at"]) / 1000)
            return out

    def prune(self) -> int:
        """Deletes finished events older than the retention window.

        Returns:
            How many were deleted.
        """
        with self._lock:
            return (
                self._conn()
                .execute(
                    "DELETE FROM starter_crm_events WHERE site_id = ? AND done_at IS NOT NULL AND done_at < ?",
                    (self._site, self._now() - self._keep_ms),
                )
                .rowcount
            )

    def applied_migrations(self) -> list[str]:
        """The names of the migrations that have run, for ``migrate:status``.

        Returns:
            The names, in order.
        """
        with self._lock:
            return [row[0] for row in self._conn().execute("SELECT name FROM starter_crm_migrations ORDER BY name")]

    def ready(self) -> bool:
        """Whether the file answers a query.

        Returns:
            False when the store is not started or the query fails.
        """
        try:
            with self._lock:
                self._conn().execute("SELECT 1").fetchone()
            return True
        except (sqlite3.Error, RuntimeError):
            return False

    def close(self) -> None:
        """Closes the file."""
        with self._lock:
            if self._db is not None:
                self._db.close()
                self._db = None

    def _finish(self, event_id: str, status: str, error: str | None) -> None:
        """Marks an event finished.

        Args:
            event_id: The event id.
            status: ``processed`` or ``failed``.
            error: The last error text for ``failed``, else None (keeps any earlier text).
        """
        with self._lock:
            self._conn().execute(
                "UPDATE starter_crm_events SET status = ?, done_at = ?, last_error = COALESCE(?, last_error) "
                "WHERE site_id = ? AND event_id = ?",
                (status, self._now(), error, self._site, event_id),
            )


def create(ctx: Any, now: Callable[[], int] | None = None) -> SqliteStore:
    """Creates the store; the file is opened by ``start()``.

    Args:
        ctx: The provider context.
        now: Clock in epoch milliseconds, replaced in tests.

    Returns:
        The store instance.
    """
    return SqliteStore(ctx.config, now)
