"""The ``sqlite`` data provider: module documents in one file on disk.

Where it sits: ``DC_DATA=sqlite``, which is also what ``DC_STORE=sqlite`` selects. It opens the same file as
the event store (``DC_SQLITE_PATH``, default ``data/starter-crm.sqlite`` under the starter root), so one file
holds everything and one copy backs it all up. It uses the standard library's ``sqlite3`` with the write-ahead
log on. Documents are rows of ``starter_crm_data``, created by ``server/migrations/sqlite/002_module_data.sql``,
which the Node server shares: either server can open the other's file. The file is opened in ``start()``, not at
creation, because a connection must never be carried across Gunicorn's fork.

SQLite allows one writer at a time and cannot be shared across machines, so run one instance; use ``postgres``
to scale out. The Node server has the same provider (``src/providers/data/sqlite.js``).

CONTRACT.md: "Module data".
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
from ..store.common import site_key
from .common import Views, new_id, to_document

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


def _from_row(row: sqlite3.Row) -> dict:
    """Turns a database row into a document.

    Args:
        row: A row of ``starter_crm_data``.

    Returns:
        The document.
    """
    return to_document(dict(row), json.loads(row["data"]))


class _Rows:
    """The row operations, over one connection guarded by a lock."""

    def __init__(self, config: Any, now: Callable[[], int]):
        """Prepares the operations; nothing is opened until ``open()``.

        Args:
            config: The loaded config (site id, root, SQLite path).
            now: Clock in epoch milliseconds.
        """
        self._now = now
        self._site = site_key(config)
        self._file = (Path(config.root) / config.events.sqlite_path).resolve()
        self._lock = threading.RLock()
        self._db: sqlite3.Connection | None = None

    def open(self) -> None:
        """Creates the folder, opens the file and applies migrations. Safe to call twice."""
        with self._lock:
            if self._db is not None:
                return
            self._file.parent.mkdir(parents=True, exist_ok=True)
            # isolation_level=None: autocommit, so the transactions below are explicit and visible.
            db = sqlite3.connect(self._file, isolation_level=None, check_same_thread=False, timeout=5)
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA journal_mode = WAL")
            # The same file and the same trade-off as the event store; see providers/store/sqlite.py.
            db.execute("PRAGMA synchronous = NORMAL")
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
            raise RuntimeError("the sqlite data provider is not started")
        return self._db

    def _visible(self, collection: str, owner: str | None, doc_id: str) -> sqlite3.Row | None:
        """Reads one row the caller may see.

        Args:
            collection: The collection.
            owner: The owner to limit to, or None for any.
            doc_id: The document id.

        Returns:
            The row, or None when it is missing or another owner's.
        """
        row = (
            self._conn()
            .execute(
                "SELECT * FROM starter_crm_data WHERE site_id = ? AND collection = ? AND id = ?",
                (self._site, collection, doc_id),
            )
            .fetchone()
        )
        return row if row is not None and (owner is None or row["owner_id"] == owner) else None

    def insert(self, collection: str, owner: str, fields: dict) -> dict:
        """Adds a row.

        Args:
            collection: The collection.
            owner: The owner id.
            fields: The checked fields.

        Returns:
            The stored document.
        """
        with self._lock:
            at = self._now()
            doc_id = new_id()
            self._conn().execute(
                "INSERT INTO starter_crm_data (site_id, collection, id, owner_id, data, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (self._site, collection, doc_id, owner, json.dumps(fields), at, at),
            )
            return _from_row(self._visible(collection, None, doc_id))

    def get(self, collection: str, owner: str | None, doc_id: str) -> dict | None:
        """Reads a document.

        Args:
            collection: The collection.
            owner: The owner to limit to, or None for any.
            doc_id: The document id.

        Returns:
            The document, or None.
        """
        with self._lock:
            row = self._visible(collection, owner, doc_id)
            return _from_row(row) if row is not None else None

    def list(self, collection: str, owner: str | None, where: list[tuple[str, Any]], limit: int) -> list[dict]:
        """Lists documents, newest first.

        Args:
            collection: The collection.
            owner: The owner to limit to, or None for any.
            where: The checked ``(field, value)`` pairs.
            limit: The checked limit.

        Returns:
            The documents.
        """
        text = "SELECT * FROM starter_crm_data WHERE site_id = ? AND collection = ?"
        params: list[Any] = [self._site, collection]
        if owner is not None:
            text += " AND owner_id = ?"
            params.append(owner)
        for key, value in where:
            # The field name was checked to be plain characters, and is bound as a JSON path, never put into the SQL.
            # SQLite stores true as 1, so the JSON type is checked too: filtering on 1 must not find true.
            if isinstance(value, bool):
                types = "('true', 'false')"
            elif isinstance(value, (int, float)):
                types = "('integer', 'real')"
            else:
                types = "('text')"
            text += " AND json_type(data, ?) IN " + types + " AND json_extract(data, ?) = ?"
            params.extend(["$." + key, "$." + key, int(value) if isinstance(value, bool) else value])
        text += " ORDER BY created_at DESC, id DESC LIMIT ?"
        params.append(limit)
        with self._lock:
            return [_from_row(row) for row in self._conn().execute(text, params).fetchall()]

    def update(self, collection: str, owner: str | None, doc_id: str, patch: dict) -> dict | None:
        """Changes some fields of a document.

        Args:
            collection: The collection.
            owner: The owner to limit to, or None for any.
            doc_id: The document id.
            patch: The checked fields to set.

        Returns:
            The updated document, or None.
        """
        with self._lock:
            db = self._conn()
            # Read, merge and write inside one write transaction, so two writers cannot lose each other's change.
            db.execute("BEGIN IMMEDIATE")
            try:
                row = self._visible(collection, owner, doc_id)
                if row is not None:
                    merged = {**json.loads(row["data"]), **patch}
                    db.execute(
                        "UPDATE starter_crm_data SET data = ?, updated_at = ? "
                        "WHERE site_id = ? AND collection = ? AND id = ?",
                        (json.dumps(merged), max(self._now(), row["created_at"]), self._site, collection, doc_id),
                    )
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise
            return _from_row(self._visible(collection, None, doc_id)) if row is not None else None

    def remove(self, collection: str, owner: str | None, doc_id: str) -> bool:
        """Deletes a document.

        Args:
            collection: The collection.
            owner: The owner to limit to, or None for any.
            doc_id: The document id.

        Returns:
            True when a document was deleted.
        """
        with self._lock:
            if self._visible(collection, owner, doc_id) is None:
                return False
            cursor = self._conn().execute(
                "DELETE FROM starter_crm_data WHERE site_id = ? AND collection = ? AND id = ?",
                (self._site, collection, doc_id),
            )
            return cursor.rowcount == 1

    def applied_migrations(self) -> list[str]:
        """The names of the migrations that have run, for ``migrate:status``.

        Returns:
            The names, in order.
        """
        with self._lock:
            rows = self._conn().execute("SELECT name FROM starter_crm_migrations ORDER BY name")
            return [row["name"] for row in rows]

    def ready(self) -> bool:
        """Whether the file answers a query.

        Returns:
            False when the provider is not started or the query fails.
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


class SqliteData(Views):
    """The provider: ``scope()`` and ``system()`` over the SQLite row operations."""

    def __init__(self, config: Any, now: Callable[[], int] | None = None):
        """Prepares the provider; nothing is opened until ``start()``.

        Args:
            config: The loaded config.
            now: Clock in epoch milliseconds, replaced in tests.
        """
        self._sqlite = _Rows(config, now or (lambda: int(time.time() * 1000)))
        super().__init__(self._sqlite)

    def start(self) -> None:
        """Opens the file and applies migrations. Safe to call twice."""
        self._sqlite.open()

    def applied_migrations(self) -> list[str]:
        """The names of the migrations that have run.

        Returns:
            The names, in order.
        """
        return self._sqlite.applied_migrations()

    def ready(self) -> bool:
        """Whether the file answers a query.

        Returns:
            False when the provider is not started or the query fails.
        """
        return self._sqlite.ready()

    def close(self) -> None:
        """Closes the file."""
        self._sqlite.close()


def create(ctx: Any, now: Callable[[], int] | None = None) -> SqliteData:
    """Creates the provider; the file is opened by ``start()``.

    Args:
        ctx: The provider context.
        now: Clock in epoch milliseconds, replaced in tests.

    Returns:
        The provider instance.
    """
    return SqliteData(ctx.config, now)
