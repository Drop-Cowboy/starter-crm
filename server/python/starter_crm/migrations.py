"""Numbered SQL migrations for the SQL-backed stores.

Where it sits: the sqlite and postgres stores call ``migrate_sqlite()`` or
``migrate_postgres()`` once when they start, before they serve anything. The files live
in ``server/migrations/<kind>/NNN_name.sql``, shared with the Node server, so both
servers upgrade the same database the same way. They are found next to this code, not
under ``STARTER_CRM_ROOT``, because they are part of the server. ``python -m starter_crm.cli migrate:status``
lists what has run.

Two instances starting together must not both migrate. Postgres uses a transaction-scoped advisory
lock, so the second instance waits, finds nothing to do and carries on. SQLite takes
``BEGIN IMMEDIATE``, and SQLite is single-writer anyway. Both servers use the same lock
key and the same ``starter_crm_migrations`` table.

CONTRACT.md: "Event store" (Migrations).
What a customer changes: add a new numbered file; never edit one that has shipped.
"""

from __future__ import annotations

import re
import sqlite3
import time
from pathlib import Path
from typing import Any

# The advisory-lock key for Postgres migrations; the same constant as the Node server, so both contend for one lock.
LOCK_KEY = 727001

# How long a boot waits for another instance's migration before giving up.
LOCK_TIMEOUT_SECONDS = 60

# The table that records which migrations have run.
TABLE = "starter_crm_migrations"

# Where the migration files live: ``server/migrations``, two folders above ``server/python/starter_crm``.
MIGRATIONS_DIR = Path(__file__).resolve().parents[2] / "migrations"

_FILE = re.compile(r"[0-9]{3}_[a-z0-9_]+\.sql")


def read_migrations(kind: str) -> list[tuple[str, str]]:
    """Reads the migration files for one database kind, in order.

    Args:
        kind: ``sqlite`` or ``postgres``.

    Returns:
        ``(name, sql)`` pairs sorted by name (the number prefix orders them).

    Raises:
        OSError: When the folder is missing, which means the image or checkout is incomplete.
    """
    folder = MIGRATIONS_DIR / kind
    files = sorted(path for path in folder.iterdir() if _FILE.fullmatch(path.name))
    return [(path.name[: -len(".sql")], path.read_text(encoding="utf-8")) for path in files]


def _statements(sql: str) -> list[str]:
    """Splits a SQLite script into complete statements, so each can run inside one transaction.

    Python's ``executescript`` commits first, which would defeat the transaction around a migration.

    Args:
        sql: The script.

    Returns:
        Each complete statement.
    """
    out: list[str] = []
    buffer = ""
    for line in sql.splitlines(keepends=True):
        buffer += line
        if sqlite3.complete_statement(buffer):
            if buffer.strip():
                out.append(buffer)
            buffer = ""
    if buffer.strip():
        out.append(buffer)
    return out


def migrate_sqlite(db: sqlite3.Connection) -> list[str]:
    """Applies every pending migration to a SQLite database.

    Args:
        db: An open connection in autocommit mode (``isolation_level=None``).

    Returns:
        The names of the migrations this call applied.

    Raises:
        sqlite3.Error: The failing migration's error, after the whole batch is rolled back.
    """
    db.execute("CREATE TABLE IF NOT EXISTS " + TABLE + " (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)")
    applied: list[str] = []
    db.execute("BEGIN IMMEDIATE")
    try:
        done = {row[0] for row in db.execute("SELECT name FROM " + TABLE)}
        for name, sql in read_migrations("sqlite"):
            if name in done:
                continue
            for statement in _statements(sql):
                db.execute(statement)
            db.execute("INSERT INTO " + TABLE + " (name, applied_at) VALUES (?, ?)", (name, int(time.time() * 1000)))
            applied.append(name)
        db.execute("COMMIT")
    except BaseException:
        db.execute("ROLLBACK")
        raise
    return applied


def migrate_postgres(pool: Any) -> list[str]:
    """Applies every pending migration to a Postgres database, under an advisory lock.

    The lock is taken inside one transaction (``pg_advisory_xact_lock``), not for the session. A pooled connection
    string (PgBouncer in transaction mode, which Neon and Supabase hand out by default) gives each statement outside
    a transaction whichever server connection is free, so a session lock is taken on one and "released" on another
    and stays held until that server connection is recycled: every later boot then waits for it forever. A lock
    that ends with the transaction cannot leak that way. The wait is capped, so a stuck holder fails the boot with
    a message instead of hanging every request.

    Args:
        pool: An open ``psycopg_pool.ConnectionPool``.

    Returns:
        The names of the migrations this call applied.
    """
    applied: list[str] = []
    # The pool runs in autocommit, so the transaction block is the one transaction: it commits at the end and rolls
    # back on an error.
    with pool.connection() as conn, conn.transaction():
        conn.execute(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT_SECONDS}s'")
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK_KEY,))
        conn.execute("CREATE TABLE IF NOT EXISTS " + TABLE + " (name text PRIMARY KEY, applied_at bigint NOT NULL)")
        done = {row["name"] for row in conn.execute("SELECT name FROM " + TABLE).fetchall()}
        for name, sql in read_migrations("postgres"):
            if name in done:
                continue
            conn.execute(sql)
            conn.execute(
                "INSERT INTO " + TABLE + " (name, applied_at) VALUES (%s, %s)", (name, int(time.time() * 1000))
            )
            applied.append(name)
    return applied


def migration_status(applied_names: list[str], kind: str) -> dict[str, list[str]]:
    """Lists which migrations have run and which are waiting.

    Args:
        applied_names: The names recorded in the database.
        kind: Which folder to compare against.

    Returns:
        ``{"applied": [...], "pending": [...]}``, each in order.
    """
    done = set(applied_names)
    names = [name for name, _ in read_migrations(kind)]
    return {"applied": [n for n in names if n in done], "pending": [n for n in names if n not in done]}
