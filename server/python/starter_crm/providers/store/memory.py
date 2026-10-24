"""The ``memory`` event store: events held in this process, the default.

Where it sits: ``DC_STORE=memory`` (or nothing set). Events vanish on restart, which is
fine for a first run and the test suites, and wrong for anything you cannot lose: set
``DC_STORE`` to sqlite, postgres or redis. It shares the store interface with those
three (see ``common.STORE_METHODS``), so a handler or a test cannot tell them apart.

Requests run on several threads, so every method takes one lock. Finished events past
``MAX_FINISHED`` are dropped oldest first, so a long-running dev server cannot grow
without bound.

CONTRACT.md: "Event store".
What a customer changes: nothing.
"""

from __future__ import annotations

import copy
import threading
import time
from collections.abc import Callable
from typing import Any

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
)

name = "memory"
config_keys: list[str] = []

# Finished events kept beyond this many are dropped oldest first.
MAX_FINISHED = 5000


def validate(env: Any) -> list[BootProblem]:
    """Nothing to configure.

    Args:
        env: The merged environment (unused).

    Returns:
        No problems.
    """
    return []


class MemoryStore:
    """An event store held in a dict, safe to share between threads."""

    def __init__(self, config: Any, now: Callable[[], int] | None = None):
        """Creates an empty store.

        Args:
            config: The loaded config; only the retention window is read.
            now: Clock in epoch milliseconds, replaced in tests.
        """
        self._now = now or (lambda: int(time.time() * 1000))
        self._keep_ms = retention_ms(config)
        self._rows: dict[str, dict] = {}
        self._lock = threading.Lock()

    def start(self) -> None:
        """Nothing to open."""

    def record(self, event: dict, visible_at: int | None = None) -> dict:
        """Stores a new event as ``received``, unless its id is already stored.

        Args:
            event: ``event_id``, ``event``, ``event_at``, ``received_at``, ``attempt`` and ``data``.
            visible_at: When the outbox may first pick the event up (epoch ms); now by default.

        Returns:
            ``{"inserted": bool, "status": str}``; the status is the stored copy's when it was a duplicate.
        """
        with self._lock:
            existing = self._rows.get(event["event_id"])
            if existing is not None:
                return {"inserted": False, "status": existing["status"]}
            self._rows[event["event_id"]] = {
                "event_id": event["event_id"],
                "event": event["event"],
                "event_at": event["event_at"],
                "received_at": event["received_at"],
                "attempt": event["attempt"],
                "data": copy.deepcopy(event["data"]),
                "contact_id": contact_id_of(event["data"]),
                "status": RECEIVED,
                "attempts": 0,
                "next_attempt_at": visible_at if visible_at is not None else self._now(),
                "last_error": None,
                "done_at": None,
            }
            return {"inserted": True, "status": RECEIVED}

    def get(self, event_id: str) -> dict | None:
        """Reads one event.

        Args:
            event_id: The event id.

        Returns:
            A copy of the stored row, or None.
        """
        with self._lock:
            row = self._rows.get(event_id)
            return copy.deepcopy(row) if row else None

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
            row = self._rows.get(event_id)
            if row is None:
                return 0
            row["attempts"] += 1
            row["last_error"] = str(error)
            row["next_attempt_at"] = next_attempt_at
            return row["attempts"]

    def since(self, after_event_id: str | None = None, limit: int | None = None) -> list[dict]:
        """Finished events after a cursor, oldest first.

        Args:
            after_event_id: The last event the caller saw. Unknown (or unfinished) ids return the latest events.
            limit: At most this many, capped at 200.

        Returns:
            Public events, replaying from ``REPLAY_OVERLAP_MS`` before the cursor's finish time.
        """
        with self._lock:
            done = self._finished()
            cursor = self._rows.get(after_event_id) if after_event_id else None
            start = cursor["done_at"] - REPLAY_OVERLAP_MS if cursor and cursor["done_at"] is not None else float("-inf")
            window = [row for row in done if row["done_at"] >= start and row["event_id"] != after_event_id]
            return [public_event(copy.deepcopy(row)) for row in window[-replay_limit(limit) :]]

    def pending(self, limit: int = 10, lease_ms: int = DEFAULT_LEASE_MS) -> list[dict]:
        """Claims received events that are due, leasing them so no other worker takes them.

        Args:
            limit: How many to claim.
            lease_ms: How long the claim lasts.

        Returns:
            Copies of the claimed rows.
        """
        with self._lock:
            at = self._now()
            due = sorted(
                (row for row in self._rows.values() if row["status"] == RECEIVED and row["next_attempt_at"] <= at),
                key=lambda row: row["next_attempt_at"],
            )[:limit]
            for row in due:
                row["next_attempt_at"] = at + lease_ms
            return [copy.deepcopy(row) for row in due]

    def list_failed(self, limit: int = 50) -> list[dict]:
        """Failed events, newest first.

        Args:
            limit: At most this many.

        Returns:
            Copies of the failed rows.
        """
        with self._lock:
            failed = sorted(
                (row for row in self._rows.values() if row["status"] == FAILED), key=lambda row: -row["done_at"]
            )
            return [copy.deepcopy(row) for row in failed[:limit]]

    def replay(self, event_id: str) -> bool:
        """Puts a failed event back to ``received`` so its handlers run again.

        Args:
            event_id: The event id.

        Returns:
            True when the event was failed and is queued again.
        """
        with self._lock:
            row = self._rows.get(event_id)
            if row is None or row["status"] != FAILED:
                return False
            row["status"] = RECEIVED
            row["attempts"] = 0
            row["done_at"] = None
            row["next_attempt_at"] = self._now()
            return True

    def purge_contact(self, contact_id: str, keep_event_id: str | None = None) -> int:
        """Deletes every stored event about a contact, and scrubs the one that triggered the purge.

        Args:
            contact_id: The contact.
            keep_event_id: The ``contact.deleted`` event itself, kept with its data reduced to the contact id.

        Returns:
            How many events were deleted.
        """
        with self._lock:
            removed = 0
            for row in list(self._rows.values()):
                if row["contact_id"] != contact_id:
                    continue
                if row["event_id"] == keep_event_id:
                    row["data"] = {"contact_id": contact_id}
                    continue
                del self._rows[row["event_id"]]
                removed += 1
            return removed

    def counts(self) -> dict:
        """Counts events by status.

        Returns:
            ``received``, ``processed``, ``failed`` and ``oldest_received_age_seconds``.
        """
        with self._lock:
            at = self._now()
            out = {RECEIVED: 0, PROCESSED: 0, FAILED: 0, "oldest_received_age_seconds": 0}
            for row in self._rows.values():
                out[row["status"]] += 1
                if row["status"] == RECEIVED:
                    out["oldest_received_age_seconds"] = max(
                        out["oldest_received_age_seconds"], round((at - row["received_at"]) / 1000)
                    )
            return out

    def prune(self) -> int:
        """Deletes finished events older than the retention window.

        Returns:
            How many were deleted.
        """
        with self._lock:
            cutoff = self._now() - self._keep_ms
            stale = [
                row["event_id"] for row in self._rows.values() if row["done_at"] is not None and row["done_at"] < cutoff
            ]
            for event_id in stale:
                del self._rows[event_id]
            return len(stale)

    def ready(self) -> bool:
        """A memory store is always ready.

        Returns:
            True.
        """
        return True

    def close(self) -> None:
        """Nothing to close."""

    def _finished(self) -> list[dict]:
        """The finished rows, oldest first, by finish time then id."""
        return sorted(
            (row for row in self._rows.values() if row["done_at"] is not None),
            key=lambda row: (row["done_at"], row["event_id"]),
        )

    def _finish(self, event_id: str, status: str, error: str | None) -> None:
        """Marks a row finished and drops the oldest finished rows past the cap."""
        with self._lock:
            row = self._rows.get(event_id)
            if row is None:
                return
            row["status"] = status
            row["done_at"] = self._now()
            if error is not None:
                row["last_error"] = error
            done = self._finished()
            for old in done[: max(0, len(done) - MAX_FINISHED)]:
                del self._rows[old["event_id"]]


def create(ctx: Any, now: Callable[[], int] | None = None) -> MemoryStore:
    """Creates the store.

    Args:
        ctx: The provider context; ``ctx.config`` supplies the retention window.
        now: Clock in epoch milliseconds, replaced in tests.

    Returns:
        The store instance.
    """
    return MemoryStore(ctx.config, now)
