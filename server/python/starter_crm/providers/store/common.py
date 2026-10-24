"""Helpers every event store shares, so the four built-in stores (and yours) agree.

Where it sits: ``memory``, ``sqlite``, ``postgres`` and ``redis`` import these. The
rules live in one place on purpose: a store that disagrees about the replay window or
the status words would pass its own tests and still break a reconnecting browser. The
Node server has the same file (``src/providers/store/common.js``).

CONTRACT.md: "Event store".
What a customer changes: nothing; when you write your own store, import these instead
of re-deriving them.
"""

from __future__ import annotations

from typing import Any

from ...redis_util import site_key

# The statuses an event moves through: ``received`` until its handlers have run, then
# ``processed`` or, after too many failures, ``failed``.
RECEIVED = "received"
PROCESSED = "processed"
FAILED = "failed"

# How far back a reconnecting browser's replay reaches before its last event. Instances finish events a moment
# apart, so a cursor taken from one instance can sit just after an event another instance finished slightly
# later. Five seconds of overlap catches those; the event stream de-duplicates by id, so it never shows twice.
REPLAY_OVERLAP_MS = 5000

# The most events a replay returns, whatever the caller asks for.
REPLAY_CAP = 200

# How long an in-flight claim on a received event lasts before another worker may take it.
DEFAULT_LEASE_MS = 60000

# The methods a custom ``DC_STORE`` provider's instance must have; boot checks for them.
STORE_METHODS = (
    "record",
    "get",
    "mark_processed",
    "mark_failed",
    "note_failure",
    "since",
    "pending",
    "list_failed",
    "replay",
    "purge_contact",
    "counts",
    "prune",
    "ready",
    "close",
)

__all__ = [
    "DEFAULT_LEASE_MS",
    "FAILED",
    "PROCESSED",
    "RECEIVED",
    "REPLAY_CAP",
    "REPLAY_OVERLAP_MS",
    "STORE_METHODS",
    "contact_id_of",
    "public_event",
    "replay_limit",
    "retention_ms",
    "site_key",
]


def contact_id_of(data: Any) -> str | None:
    """Picks the contact an event is about, so ``contact.deleted`` can purge that contact's events.

    Args:
        data: The event's ``data`` object.

    Returns:
        ``data["contact_id"]`` when it is a non-empty string, else None.
    """
    if isinstance(data, dict) and isinstance(data.get("contact_id"), str) and data["contact_id"] != "":
        return data["contact_id"]
    return None


def public_event(row: dict) -> dict:
    """Trims a stored row down to the event the browser receives.

    The status, attempt counters and error text are the server's business, not the page's.

    Args:
        row: An event as a store holds it.

    Returns:
        The wire shape of an event: ``event_id``, ``event``, ``event_at``, ``received_at``, ``attempt`` and ``data``.
    """
    return {
        "event_id": row["event_id"],
        "event": row["event"],
        "event_at": row["event_at"],
        "received_at": row["received_at"],
        "attempt": row["attempt"],
        "data": row["data"],
    }


def replay_limit(limit: int | None) -> int:
    """Clamps a replay limit.

    Args:
        limit: What the caller asked for.

    Returns:
        A whole number from 1 to ``REPLAY_CAP``; ``REPLAY_CAP`` when unset.
    """
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1:
        return REPLAY_CAP
    return min(limit, REPLAY_CAP)


def retention_ms(config: Any) -> int:
    """The retention window in milliseconds.

    Args:
        config: The loaded config.

    Returns:
        Milliseconds events are kept after they finish.
    """
    hours = config.events.retention_hours if config.events and config.events.retention_hours else 72
    return int(hours) * 3600 * 1000
