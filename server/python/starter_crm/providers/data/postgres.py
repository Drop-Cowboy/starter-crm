"""The ``postgres`` data provider: module documents in a Postgres table every instance shares.

Where it sits: ``DC_DATA=postgres``, which is also what ``DC_STORE=postgres`` selects, with the connection
string in ``DC_DATABASE_URL`` (or ``DATABASE_URL``). This is the provider for more than one instance, and the
one to back up with your host's point-in-time recovery. Documents are rows of ``starter_crm_data`` with a
``jsonb`` column, created by ``server/migrations/postgres/002_module_data.sql`` under the same advisory lock as
the event store's tables. The Node server shares the table. The pool is opened in ``start()``, never at creation,
so it is safe in Gunicorn's master before the fork.

A ``where`` filter becomes jsonb containment (``data @> {"stage": "won"}``), so it matches the value's type
exactly: the string ``"1"`` does not match the number ``1``. The Node server has the same provider
(``src/providers/data/postgres.js``).

CONTRACT.md: "Module data".
Env: DC_DATABASE_URL, DATABASE_URL or NETLIFY_DB_URL. What a customer changes: nothing.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from typing import Any

from ...migrations import migrate_postgres
from ...problems import BootProblem, problem
from ..store import postgres as postgres_store
from ..store.common import site_key
from .common import Views, new_id, to_document

name = "postgres"
config_keys = ["DC_DATABASE_URL", "DATABASE_URL", "NETLIFY_DB_URL"]


def validate(env: Mapping[str, str]) -> list[BootProblem]:
    """Checks the connection string the way the event store does, so a bad URL is reported once, not once per piece.

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    if not postgres_store.database_url(env):
        return [
            problem(
                "missing_database_url",
                "DC_DATA=postgres needs DC_DATABASE_URL.",
                "Set DC_DATABASE_URL (or DATABASE_URL) to your Postgres connection string, or choose DC_DATA=sqlite.",
            )
        ]
    return postgres_store.validate(env)


def _from_row(row: dict) -> dict:
    """Turns a database row into a document.

    Args:
        row: A row of ``starter_crm_data`` as a dict (``data`` is already parsed).

    Returns:
        The document.
    """
    return to_document(row, row["data"])


class _Rows:
    """The row operations, over a connection pool."""

    def __init__(self, config: Any, env: Mapping[str, str], now: Callable[[], int]):
        """Prepares the operations; nothing connects until ``open()``.

        Args:
            config: The loaded config (site id).
            env: The merged environment, for the connection string.
            now: Clock in epoch milliseconds.
        """
        self._now = now
        self._site = site_key(config)
        self._url = postgres_store.database_url(env)
        self._pool: Any = None

    def open(self) -> None:
        """Opens the pool, checks the database answers and applies migrations. Safe to call twice."""
        if self._pool is not None:
            return
        # The driver is only needed when this provider is chosen, so it is not imported at module load.
        from psycopg.rows import dict_row
        from psycopg_pool import ConnectionPool

        pool = ConnectionPool(
            self._url,
            min_size=1,
            max_size=10,
            open=False,
            timeout=5,
            kwargs={"autocommit": True, "row_factory": dict_row},
        )
        pool.open(wait=True, timeout=10)
        try:
            migrate_postgres(pool)
        except BaseException:
            pool.close()
            raise
        self._pool = pool

    def _query(self, sql: str, params: tuple = ()) -> list[dict]:
        """Runs one statement and returns its rows.

        Args:
            sql: The statement, with ``%s`` placeholders.
            params: Its values.

        Returns:
            The rows as dicts (none for a statement that returns none).

        Raises:
            RuntimeError: When ``start()`` has not run.
        """
        if self._pool is None:
            raise RuntimeError("the postgres data provider is not started")
        with self._pool.connection() as conn:
            cursor = conn.execute(sql, params)
            return cursor.fetchall() if cursor.description else []

    def insert(self, collection: str, owner: str, fields: dict) -> dict:
        """Adds a row.

        Args:
            collection: The collection.
            owner: The owner id.
            fields: The checked fields.

        Returns:
            The stored document.
        """
        from psycopg.types.json import Jsonb

        at = self._now()
        rows = self._query(
            "INSERT INTO starter_crm_data (site_id, collection, id, owner_id, data, created_at, updated_at) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING *",
            (self._site, collection, new_id(), owner, Jsonb(fields), at, at),
        )
        return _from_row(rows[0])

    def get(self, collection: str, owner: str | None, doc_id: str) -> dict | None:
        """Reads a document.

        Args:
            collection: The collection.
            owner: The owner to limit to, or None for any.
            doc_id: The document id.

        Returns:
            The document, or None.
        """
        rows = self._query(
            "SELECT * FROM starter_crm_data WHERE site_id = %s AND collection = %s AND id = %s "
            "AND (%s::text IS NULL OR owner_id = %s)",
            (self._site, collection, doc_id, owner, owner),
        )
        return _from_row(rows[0]) if rows else None

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
        from psycopg.types.json import Jsonb

        rows = self._query(
            "SELECT * FROM starter_crm_data WHERE site_id = %s AND collection = %s "
            "AND (%s::text IS NULL OR owner_id = %s) AND data @> %s::jsonb "
            "ORDER BY created_at DESC, id DESC LIMIT %s",
            (self._site, collection, owner, owner, Jsonb(dict(where)), limit),
        )
        return [_from_row(row) for row in rows]

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
        from psycopg.types.json import Jsonb

        # ``||`` merges the top-level keys in one statement, so two writers cannot lose each other's change.
        rows = self._query(
            "UPDATE starter_crm_data SET data = data || %s::jsonb, updated_at = GREATEST(%s::bigint, created_at) "
            "WHERE site_id = %s AND collection = %s AND id = %s AND (%s::text IS NULL OR owner_id = %s) RETURNING *",
            (Jsonb(patch), self._now(), self._site, collection, doc_id, owner, owner),
        )
        return _from_row(rows[0]) if rows else None

    def remove(self, collection: str, owner: str | None, doc_id: str) -> bool:
        """Deletes a document.

        Args:
            collection: The collection.
            owner: The owner to limit to, or None for any.
            doc_id: The document id.

        Returns:
            True when a document was deleted.
        """
        rows = self._query(
            "DELETE FROM starter_crm_data WHERE site_id = %s AND collection = %s AND id = %s "
            "AND (%s::text IS NULL OR owner_id = %s) RETURNING id",
            (self._site, collection, doc_id, owner, owner),
        )
        return len(rows) == 1

    def applied_migrations(self) -> list[str]:
        """The names of the migrations that have run, for ``migrate:status``.

        Returns:
            The names, in order.
        """
        return [row["name"] for row in self._query("SELECT name FROM starter_crm_migrations ORDER BY name")]

    def ready(self) -> bool:
        """Whether the database answers a query.

        Returns:
            False when the provider is not started or the query fails.
        """
        try:
            self._query("SELECT 1")
            return True
        except Exception:  # noqa: BLE001 - any driver or pool error means not ready
            return False

    def close(self) -> None:
        """Closes the pool."""
        if self._pool is not None:
            self._pool.close()
            self._pool = None


class PostgresData(Views):
    """The provider: ``scope()`` and ``system()`` over the Postgres row operations."""

    def __init__(self, config: Any, env: Mapping[str, str], now: Callable[[], int] | None = None):
        """Prepares the provider; nothing connects until ``start()``.

        Args:
            config: The loaded config.
            env: The merged environment.
            now: Clock in epoch milliseconds, replaced in tests.
        """
        self._postgres = _Rows(config, env, now or (lambda: int(time.time() * 1000)))
        super().__init__(self._postgres)

    def start(self) -> None:
        """Opens the pool and applies migrations. Safe to call twice."""
        self._postgres.open()

    def applied_migrations(self) -> list[str]:
        """The names of the migrations that have run.

        Returns:
            The names, in order.
        """
        return self._postgres.applied_migrations()

    def ready(self) -> bool:
        """Whether the database answers a query.

        Returns:
            False when the provider is not started or the query fails.
        """
        return self._postgres.ready()

    def close(self) -> None:
        """Closes the pool."""
        self._postgres.close()


def create(ctx: Any, now: Callable[[], int] | None = None) -> PostgresData:
    """Creates the provider; the pool is opened by ``start()``.

    Args:
        ctx: The provider context (config and merged env).
        now: Clock in epoch milliseconds, replaced in tests.

    Returns:
        The provider instance.
    """
    return PostgresData(ctx.config, ctx.env, now)
