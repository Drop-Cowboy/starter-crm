"""The ``postgres`` event store: events in a Postgres database, for several instances.

Where it sits: ``DC_STORE=postgres``, with ``DC_DATABASE_URL`` (or the ``DATABASE_URL`` that
Neon and most hosts set, or the ``NETLIFY_DB_URL`` that Netlify Database sets). Every row carries
the app's site id, so two apps can share one database without seeing each other's events.
Migrations in ``server/migrations/postgres`` run when the store starts, under an advisory
lock, so two instances booting together do not race. The Node server uses the same table.

The pool is opened in ``start()`` rather than at creation, because a connection pool and
its threads must never be carried across Gunicorn's fork. Workers claim events with
``FOR UPDATE SKIP LOCKED``, so two workers never take the same one.

CONTRACT.md: "Event store".
Env: DC_DATABASE_URL, DATABASE_URL or NETLIFY_DB_URL. What a customer changes: nothing.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from typing import Any
from urllib.parse import urlparse

from ...migrations import migrate_postgres
from ...problems import BootProblem, problem
from ...tls import allows_plaintext
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

name = "postgres"
config_keys = ["DC_DATABASE_URL", "DATABASE_URL", "NETLIFY_DB_URL"]

LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")


def database_url(env: Mapping[str, str]) -> str | None:
    """Reads the connection string.

    Args:
        env: The merged environment.

    Returns:
        ``DC_DATABASE_URL``, else ``DATABASE_URL``, else ``NETLIFY_DB_URL``, else None.
    """
    for key in ("DC_DATABASE_URL", "DATABASE_URL", "NETLIFY_DB_URL"):
        value = env.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def validate(env: Mapping[str, str]) -> list[BootProblem]:
    """Checks the connection string is present, is a Postgres URL, and asks for TLS in production.

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    raw = database_url(env)
    if not raw:
        return [
            problem(
                "missing_database_url",
                "DC_STORE=postgres needs DC_DATABASE_URL.",
                "Set DC_DATABASE_URL (or DATABASE_URL) to your Postgres connection string, for example "
                "postgres://user:password@host:5432/dbname?sslmode=require.",
            )
        ]
    try:
        url = urlparse(raw)
        scheme, host = url.scheme, url.hostname or ""
    except ValueError:
        return [
            problem(
                "invalid_database_url",
                "DC_DATABASE_URL is not a URL.",
                "Use a connection string such as postgres://user:password@host:5432/dbname.",
            )
        ]
    if scheme not in ("postgres", "postgresql"):
        return [
            problem(
                "invalid_database_url",
                "DC_DATABASE_URL must start with postgres:// or postgresql://.",
                "Use a connection string such as postgres://user:password@host:5432/dbname.",
            )
        ]
    query = dict(part.split("=", 1) for part in url.query.split("&") if "=" in part)
    tls = query.get("sslmode", "") in ("require", "verify-ca", "verify-full")
    if env.get("DC_ENV") == "production" and host not in LOCAL_HOSTS and not tls and not allows_plaintext(env):
        return [
            problem(
                "insecure_database_url",
                "DC_DATABASE_URL must use TLS in production.",
                "Add ?sslmode=require (or verify-full) to the connection string. Localhost is exempt, and so is a "
                "private network you control when DC_INSECURE_PRIVATE_SERVICES=on.",
            )
        ]
    return []


def _from_row(row: dict | None) -> dict | None:
    """Turns a database row into an event dict.

    Args:
        row: A row (as a dict) from the events table, or None.

    Returns:
        The event with numeric columns as ints, or None for no row.
    """
    if row is None:
        return None

    def number(value: Any) -> int | None:
        return None if value is None else int(value)

    return {
        "event_id": row["event_id"],
        "event": row["event"],
        "event_at": number(row["event_at"]),
        "received_at": number(row["received_at"]),
        "attempt": row["attempt"],
        "data": row["data"],
        "contact_id": row["contact_id"],
        "status": row["status"],
        "attempts": row["attempts"],
        "next_attempt_at": number(row["next_attempt_at"]),
        "last_error": row["last_error"],
        "done_at": number(row["done_at"]),
    }


class PostgresStore:
    """An event store in Postgres, behind a connection pool."""

    def __init__(self, config: Any, env: Mapping[str, str], now: Callable[[], int] | None = None):
        """Prepares the store; nothing connects until ``start()``.

        Args:
            config: The loaded config (site id, root, retention).
            env: The merged environment, for the connection string.
            now: Clock in epoch milliseconds, replaced in tests.
        """
        self._now = now or (lambda: int(time.time() * 1000))
        self._site = site_key(config)
        self._keep_ms = retention_ms(config)
        self._url = database_url(env)
        self._pool: Any = None

    def start(self) -> None:
        """Opens the pool, checks the database answers and applies migrations. Safe to call twice."""
        if self._pool is not None:
            return
        # The driver is only needed when this store is chosen, so it is not imported at module load.
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
        """Runs one statement and returns its rows (empty for statements that return none).

        Args:
            sql: The statement, with ``%s`` placeholders.
            params: Its values.

        Returns:
            The rows as dicts (none for a statement that returns none).

        Raises:
            RuntimeError: When ``start()`` has not run.
        """
        if self._pool is None:
            raise RuntimeError("the postgres event store is not started")
        with self._pool.connection() as conn:
            cursor = conn.execute(sql, params)
            return cursor.fetchall() if cursor.description else []

    def _rowcount(self, sql: str, params: tuple = ()) -> int:
        """Runs a statement that returns no rows and reports how many rows it changed.

        Args:
            sql: The statement.
            params: Its values.

        Returns:
            The affected row count.

        Raises:
            RuntimeError: When ``start()`` has not run.
        """
        if self._pool is None:
            raise RuntimeError("the postgres event store is not started")
        with self._pool.connection() as conn:
            return conn.execute(sql, params).rowcount

    def record(self, event: dict, visible_at: int | None = None) -> dict:
        """Stores a new event as ``received``, unless its id is already stored.

        Args:
            event: ``event_id``, ``event``, ``event_at``, ``received_at``, ``attempt`` and ``data``.
            visible_at: When the outbox may first pick the event up (epoch ms); now by default.

        Returns:
            ``{"inserted": bool, "status": str}``.
        """
        from psycopg.types.json import Jsonb

        inserted = self._rowcount(
            "INSERT INTO starter_crm_events (site_id, event_id, event, event_at, received_at, attempt, contact_id, "
            "data, status, attempts, next_attempt_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 0, %s) "
            "ON CONFLICT (site_id, event_id) DO NOTHING",
            (
                self._site,
                event["event_id"],
                event["event"],
                event["event_at"],
                event["received_at"],
                event["attempt"],
                contact_id_of(event["data"]),
                Jsonb(event["data"]),
                RECEIVED,
                visible_at if visible_at is not None else self._now(),
            ),
        )
        if inserted == 1:
            return {"inserted": True, "status": RECEIVED}
        rows = self._query(
            "SELECT status FROM starter_crm_events WHERE site_id = %s AND event_id = %s",
            (self._site, event["event_id"]),
        )
        return {"inserted": False, "status": rows[0]["status"] if rows else RECEIVED}

    def get(self, event_id: str) -> dict | None:
        """Reads one event.

        Args:
            event_id: The event id.

        Returns:
            The stored event, or None.
        """
        rows = self._query(
            "SELECT * FROM starter_crm_events WHERE site_id = %s AND event_id = %s", (self._site, event_id)
        )
        return _from_row(rows[0]) if rows else None

    def mark_processed(self, event_id: str) -> None:
        """Marks an event processed.

        Args:
            event_id: The event id.
        """
        self._rowcount(
            "UPDATE starter_crm_events SET status = %s, done_at = %s WHERE site_id = %s AND event_id = %s",
            (PROCESSED, self._now(), self._site, event_id),
        )

    def mark_failed(self, event_id: str, error: str) -> None:
        """Marks an event failed after its attempts are used up.

        Args:
            event_id: The event id.
            error: The last error text.
        """
        self._rowcount(
            "UPDATE starter_crm_events SET status = %s, done_at = %s, last_error = %s "
            "WHERE site_id = %s AND event_id = %s",
            (FAILED, self._now(), str(error), self._site, event_id),
        )

    def note_failure(self, event_id: str, error: str, next_attempt_at: int) -> int:
        """Counts a failed handler run and schedules the next attempt.

        Args:
            event_id: The event id.
            error: The error text.
            next_attempt_at: When the outbox may try again (epoch ms).

        Returns:
            How many runs have failed so far, 0 when the event is gone.
        """
        rows = self._query(
            "UPDATE starter_crm_events SET attempts = attempts + 1, last_error = %s, next_attempt_at = %s "
            "WHERE site_id = %s AND event_id = %s RETURNING attempts",
            (str(error), next_attempt_at, self._site, event_id),
        )
        return rows[0]["attempts"] if rows else 0

    def since(self, after_event_id: str | None = None, limit: int | None = None) -> list[dict]:
        """Finished events after a cursor, oldest first.

        Args:
            after_event_id: The last event the caller saw. Unknown (or unfinished) ids return the latest events.
            limit: At most this many, capped at 200.

        Returns:
            Public events, replaying from ``REPLAY_OVERLAP_MS`` before the cursor's finish time.
        """
        start = -1
        if after_event_id:
            cursor = self._query(
                "SELECT done_at FROM starter_crm_events WHERE site_id = %s AND event_id = %s",
                (self._site, after_event_id),
            )
            if cursor and cursor[0].get("done_at") is not None:
                start = int(cursor[0]["done_at"]) - REPLAY_OVERLAP_MS
        rows = self._query(
            "SELECT * FROM starter_crm_events WHERE site_id = %s AND done_at IS NOT NULL AND done_at >= %s "
            "AND event_id <> %s ORDER BY done_at DESC, event_id DESC LIMIT %s",
            (self._site, start, after_event_id or "", replay_limit(limit)),
        )
        return [public_event(_from_row(row)) for row in reversed(rows)]

    def pending(self, limit: int = 10, lease_ms: int = DEFAULT_LEASE_MS) -> list[dict]:
        """Claims received events that are due, leasing them so no other worker takes them.

        Args:
            limit: How many to claim.
            lease_ms: How long the claim lasts.

        Returns:
            The claimed events.
        """
        at = self._now()
        # SKIP LOCKED: a second worker running this at the same moment gets different events, never the same ones.
        rows = self._query(
            "UPDATE starter_crm_events SET next_attempt_at = %s WHERE (site_id, event_id) IN ("
            "SELECT site_id, event_id FROM starter_crm_events WHERE site_id = %s AND status = 'received' "
            "AND next_attempt_at <= %s ORDER BY next_attempt_at LIMIT %s FOR UPDATE SKIP LOCKED) RETURNING *",
            (at + lease_ms, self._site, at, limit),
        )
        return [_from_row(row) for row in rows]

    def list_failed(self, limit: int = 50) -> list[dict]:
        """Failed events, newest first.

        Args:
            limit: At most this many.

        Returns:
            The failed events.
        """
        rows = self._query(
            "SELECT * FROM starter_crm_events WHERE site_id = %s AND status = 'failed' ORDER BY done_at DESC LIMIT %s",
            (self._site, limit),
        )
        return [_from_row(row) for row in rows]

    def replay(self, event_id: str) -> bool:
        """Puts a failed event back to ``received`` so its handlers run again.

        Args:
            event_id: The event id.

        Returns:
            True when the event was failed and is queued again.
        """
        return (
            self._rowcount(
                "UPDATE starter_crm_events SET status = 'received', attempts = 0, done_at = NULL, next_attempt_at = %s "
                "WHERE site_id = %s AND event_id = %s AND status = 'failed'",
                (self._now(), self._site, event_id),
            )
            == 1
        )

    def purge_contact(self, contact_id: str, keep_event_id: str | None = None) -> int:
        """Deletes every stored event about a contact, and scrubs the one that triggered the purge.

        Args:
            contact_id: The contact.
            keep_event_id: The ``contact.deleted`` event itself, kept with its data reduced to the contact id.

        Returns:
            How many events were deleted.
        """
        from psycopg.types.json import Jsonb

        removed = self._rowcount(
            "DELETE FROM starter_crm_events WHERE site_id = %s AND contact_id = %s AND event_id <> %s",
            (self._site, contact_id, keep_event_id or ""),
        )
        if keep_event_id:
            self._rowcount(
                "UPDATE starter_crm_events SET data = %s WHERE site_id = %s AND event_id = %s",
                (Jsonb({"contact_id": contact_id}), self._site, keep_event_id),
            )
        return removed

    def counts(self) -> dict:
        """Counts events by status.

        Returns:
            ``received``, ``processed``, ``failed`` and ``oldest_received_age_seconds``.
        """
        out = {RECEIVED: 0, PROCESSED: 0, FAILED: 0, "oldest_received_age_seconds": 0}
        for row in self._query(
            "SELECT status, COUNT(*)::int AS n FROM starter_crm_events WHERE site_id = %s GROUP BY status",
            (self._site,),
        ):
            out[row["status"]] = row["n"]
        oldest = self._query(
            "SELECT MIN(received_at) AS at FROM starter_crm_events WHERE site_id = %s AND status = 'received'",
            (self._site,),
        )
        if oldest and oldest[0].get("at") is not None:
            out["oldest_received_age_seconds"] = round((self._now() - int(oldest[0]["at"])) / 1000)
        return out

    def prune(self) -> int:
        """Deletes finished events older than the retention window.

        Returns:
            How many were deleted.
        """
        return self._rowcount(
            "DELETE FROM starter_crm_events WHERE site_id = %s AND done_at IS NOT NULL AND done_at < %s",
            (self._site, self._now() - self._keep_ms),
        )

    def applied_migrations(self) -> list[str]:
        """The names of the migrations that have run, for ``migrate:status``.

        Returns:
            The names, in order.
        """
        return [row["name"] for row in self._query("SELECT name FROM starter_crm_migrations ORDER BY name")]

    def ready(self) -> bool:
        """Whether the database answers a query.

        Returns:
            False when the store is not started or the query fails.
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


def create(ctx: Any, now: Callable[[], int] | None = None) -> PostgresStore:
    """Creates the store; the pool is opened by ``start()``.

    Args:
        ctx: The provider context (config and merged env).
        now: Clock in epoch milliseconds, replaced in tests.

    Returns:
        The store instance.
    """
    return PostgresStore(ctx.config, ctx.env, now)
