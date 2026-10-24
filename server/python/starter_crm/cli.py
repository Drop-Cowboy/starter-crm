"""Operator commands for the event store: ``python -m starter_crm.cli``.

Where it sits: it boots the same config and providers as the server (so it needs the same ``.env``), runs one
command against the store, and exits. Nothing here serves HTTP. The root ``npm run webhooks:replay``,
``webhooks:failed`` and ``migrate:status`` scripts call the Node twin (``server/node/src/cli.js``); this file
is for a Python-only install.

    python -m starter_crm.cli failed                   list events that used up their attempts
    python -m starter_crm.cli replay <event_id>        run one failed event's handlers again
    python -m starter_crm.cli replay --all-failed      run every failed event again
    python -m starter_crm.cli migrate:status           list which migrations have run

``replay`` puts the event back in the outbox (or the queue) and, when this process has a worker, handles it before
exiting; with ``DC_WORKER_IN_PROCESS=off`` it only re-queues, and ``python -m starter_crm.worker`` does the rest.

CONTRACT.md: "Event store" (Replay, Migrations).
What a customer changes: nothing.
"""

from __future__ import annotations

import os
import sys
import time
from typing import Any

from dotenv import load_dotenv

from .bootstrap import bootstrap
from .config import starter_root
from .migrations import migration_status
from .problems import format_problems

# The longest ``replay`` waits for its own worker to finish what it queued.
REPLAY_WAIT_SECONDS = 30

USAGE = "Usage: python -m starter_crm.cli failed | replay <event_id> | replay --all-failed | migrate:status"


def _failed(runtime: Any) -> int:
    """Lists failed events.

    Args:
        runtime: The event runtime.

    Returns:
        The exit code.
    """
    rows = runtime.store.list_failed(limit=200)
    if not rows:
        print("No failed events.")
        return 0
    for row in rows:
        print(
            row["event_id"]
            + "  "
            + str(row["event"])
            + "  attempts="
            + str(row["attempts"])
            + "  "
            + (row["last_error"] or "")
        )
    return 0


def _replay(runtime: Any, args: list[str], config: Any) -> int:
    """Puts failed events back to ``received`` and runs them.

    Args:
        runtime: The event runtime.
        args: The command's arguments: an event id, or ``--all-failed``.
        config: The loaded config.

    Returns:
        The exit code.
    """
    if not args:
        print(USAGE, file=sys.stderr)
        return 2
    ids = [row["event_id"] for row in runtime.store.list_failed(limit=200)] if args[0] == "--all-failed" else [args[0]]
    queued = []
    for event_id in ids:
        if runtime.store.replay(event_id):
            queued.append(event_id)
            runtime.dispatcher.dispatch(event_id)
            print("Re-queued " + event_id)
        else:
            print(event_id + " is not a failed event, so it was not replayed.", file=sys.stderr)
    if not queued:
        return 0 if not ids else 1
    if not config.events.worker_in_process:
        print("Run `python -m starter_crm.worker` to finish " + str(len(queued)) + " event(s).")
        return 0
    deadline = time.monotonic() + REPLAY_WAIT_SECONDS
    code = 0
    for event_id in queued:
        while True:
            row = runtime.store.get(event_id)
            if row and row["status"] != "received":
                print(event_id + " " + row["status"])
                if row["status"] == "failed":
                    code = 1
                break
            if time.monotonic() > deadline:
                print(event_id + " is still waiting after " + str(REPLAY_WAIT_SECONDS) + " seconds.", file=sys.stderr)
                code = 1
                break
            time.sleep(0.2)
    return code


def _migrations(config: Any, runtime: Any) -> int:
    """Lists applied and pending migrations for a SQL store (or SQL module data behind a Redis store).

    Args:
        config: The loaded config.
        runtime: The event runtime.

    Returns:
        The exit code: 1 when migrations are pending.
    """
    # The store and the module data share one migrations table when both are SQL; with a Redis store, the data
    # provider owns the tables.
    sql = ("sqlite", "postgres")
    kind = config.events.store
    owner = runtime.store
    if kind not in sql and config.data.provider in sql:
        kind = config.data.provider
        owner = runtime.data
    if kind not in sql:
        print("DC_STORE=" + kind + " has no migrations.")
        return 0
    status = migration_status(owner.applied_migrations(), kind)
    for name in status["applied"]:
        print("applied  " + name)
    for name in status["pending"]:
        print("pending  " + name)
    return 1 if status["pending"] else 0


def main(argv: list[str] | None = None) -> int:
    """Runs one command.

    Args:
        argv: The arguments after the program name; ``sys.argv`` by default.

    Returns:
        The process exit code.
    """
    arguments = list(sys.argv[1:] if argv is None else argv)
    if not arguments or arguments[0] not in ("failed", "replay", "migrate:status"):
        print(USAGE, file=sys.stderr)
        return 2
    command, rest = arguments[0], arguments[1:]
    root = starter_root(os.environ)
    load_dotenv(root / ".env", override=False)
    booted = bootstrap(os.environ, root)
    if booted.problems:
        print("The command cannot run:\n" + format_problems(booted.problems), file=sys.stderr)
        return 1
    runtime = booted.runtime
    code = 1
    try:
        runtime.start()
        if command == "failed":
            code = _failed(runtime)
        elif command == "migrate:status":
            code = _migrations(booted.config, runtime)
        else:
            code = _replay(runtime, rest, booted.config)
    except Exception as err:  # noqa: BLE001 - report any failure as one line
        print("The command failed: " + (str(err) or err.__class__.__name__), file=sys.stderr)
    finally:
        runtime.stop()
    return code


if __name__ == "__main__":
    sys.exit(main())
