"""The ``redis`` event store: events in Redis (or Valkey) with persistence on.

Where it sits: ``DC_STORE=redis``, with ``DC_REDIS_URL``. It suits hosts whose only
datastore is Redis, such as Upstash on Vercel or Netlify. Each event is a hash; sorted
sets index the received events (by when the outbox may take them), the finished ones (by
when they finished, which orders replay) and the failed ones. Recording is one atomic
Lua script, so two instances racing on the same event id insert it once. The Node server
uses the same keys and scripts, so the two can share one Redis.

The server must keep its data: turn on AOF or snapshots (Upstash and ElastiCache do) and
use ``maxmemory-policy noeviction``, or Redis may drop events it was holding. Finished
events expire on their own after ``DC_EVENT_RETENTION_HOURS``.

CONTRACT.md: "Event store".
Env: DC_REDIS_URL (or REDIS_URL). What a customer changes: nothing.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Mapping
from typing import Any

from ...problems import BootProblem
from ...redis_util import key_prefix, new_client, validate_redis
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

name = "redis"
config_keys = ["DC_REDIS_URL", "REDIS_URL", "DC_REDIS_CLUSTER"]

# These scripts are the same text as the Node server's, on purpose: they define the data format.
_RECORD = """
if redis.call('EXISTS', KEYS[1]) == 1 then return {0, redis.call('HGET', KEYS[1], 'status')} end
redis.call('HSET', KEYS[1], 'json', ARGV[1], 'status', 'received', 'attempts', 0,
    'next_attempt_at', ARGV[2], 'contact_id', ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[4])
if ARGV[3] ~= '' then redis.call('SADD', KEYS[3], ARGV[4]) end
return {1, 'received'}
"""

_FINISH = """
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'done_at', ARGV[3])
if ARGV[4] ~= '' then redis.call('HSET', KEYS[1], 'last_error', ARGV[4]) end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
if ARGV[2] == 'failed' then redis.call('ZADD', KEYS[4], ARGV[3], ARGV[1]) end
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1
"""

_NOTE_FAILURE = """
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
redis.call('HSET', KEYS[1], 'last_error', ARGV[2], 'next_attempt_at', ARGV[3])
if redis.call('HGET', KEYS[1], 'status') == 'received' then redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1]) end
return attempts
"""

_CLAIM = """
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
for _, id in ipairs(ids) do redis.call('ZADD', KEYS[1], ARGV[3], id) end
return ids
"""

_REPLAY = """
if redis.call('HGET', KEYS[1], 'status') ~= 'failed' then return 0 end
redis.call('HSET', KEYS[1], 'status', 'received', 'attempts', 0, 'next_attempt_at', ARGV[2])
redis.call('HDEL', KEYS[1], 'done_at')
redis.call('PERSIST', KEYS[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
return 1
"""


def validate(env: Mapping[str, str]) -> list[BootProblem]:
    """Checks the Redis address.

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    return validate_redis(env, "DC_STORE=redis")


def _from_hash(fields: dict | None) -> dict | None:
    """Turns a stored hash into an event dict.

    Args:
        fields: The hash fields, as Redis returns them (empty for a missing key).

    Returns:
        The event, or None when the hash is empty (the event expired or never existed).
    """
    if not fields or not fields.get("json"):
        return None
    base = json.loads(fields["json"])
    return {
        "event_id": base["event_id"],
        "event": base["event"],
        "event_at": base["event_at"],
        "received_at": base["received_at"],
        "attempt": base["attempt"],
        "data": base["data"],
        "contact_id": None if fields.get("contact_id", "") == "" else fields["contact_id"],
        "status": fields["status"],
        "attempts": int(fields["attempts"]),
        "next_attempt_at": int(fields["next_attempt_at"]),
        "last_error": fields.get("last_error"),
        "done_at": int(fields["done_at"]) if fields.get("done_at") is not None else None,
    }


class RedisStore:
    """An event store in Redis, using Lua scripts for every multi-key change."""

    def __init__(self, config: Any, env: Mapping[str, str], now: Callable[[], int] | None = None, client: Any = None):
        """Prepares the store. The client connects lazily, so creating the store is safe before a fork.

        Args:
            config: The loaded config (site id, retention).
            env: The merged environment, for the Redis address.
            now: Clock in epoch milliseconds, replaced in tests.
            client: A ready ``redis.Redis`` client (tests); it is not closed by the store.
        """
        self._now = now or (lambda: int(time.time() * 1000))
        self._keep_ms = retention_ms(config)
        prefix = key_prefix(config)
        self._env = env
        self._client = client
        self._owns_client = client is None
        self._key_pending = prefix + "pending"
        self._key_done = prefix + "done"
        self._key_failed = prefix + "failed"
        self._prefix = prefix

    def start(self) -> None:
        """Connects and checks the server answers. Safe to call twice."""
        if self._client is None:
            self._client = new_client(self._env)
        self._client.ping()

    def _event_key(self, event_id: str) -> str:
        """The hash key of one event."""
        return self._prefix + "ev:" + event_id

    def _contact_key(self, contact_id: str) -> str:
        """The set key listing one contact's events."""
        return self._prefix + "contact:" + contact_id

    def _load(self, ids: list[str]) -> list[dict | None]:
        """Reads several events by id in one round trip.

        Args:
            ids: The event ids.

        Returns:
            The events in the same order; None for any that no longer exist.
        """
        if not ids:
            return []
        pipe = self._client.pipeline(transaction=False)
        for event_id in ids:
            pipe.hgetall(self._event_key(event_id))
        return [_from_hash(fields) for fields in pipe.execute()]

    def _finish(self, event_id: str, status: str, error: str) -> None:
        """Marks an event finished and schedules its expiry."""
        self._client.eval(
            _FINISH,
            4,
            self._event_key(event_id),
            self._key_pending,
            self._key_done,
            self._key_failed,
            event_id,
            status,
            str(self._now()),
            error,
            str(self._keep_ms),
        )

    def record(self, event: dict, visible_at: int | None = None) -> dict:
        """Stores a new event as ``received``, unless its id is already stored.

        Args:
            event: ``event_id``, ``event``, ``event_at``, ``received_at``, ``attempt`` and ``data``.
            visible_at: When the outbox may first pick the event up (epoch ms); now by default.

        Returns:
            ``{"inserted": bool, "status": str}``.
        """
        contact_id = contact_id_of(event["data"]) or ""
        payload = json.dumps(public_event(event), separators=(",", ":"))
        inserted, status = self._client.eval(
            _RECORD,
            3,
            self._event_key(event["event_id"]),
            self._key_pending,
            self._contact_key(contact_id),
            payload,
            str(visible_at if visible_at is not None else self._now()),
            contact_id,
            event["event_id"],
        )
        return {"inserted": inserted == 1, "status": status or RECEIVED}

    def get(self, event_id: str) -> dict | None:
        """Reads one event.

        Args:
            event_id: The event id.

        Returns:
            The stored event, or None.
        """
        return _from_hash(self._client.hgetall(self._event_key(event_id)))

    def mark_processed(self, event_id: str) -> None:
        """Marks an event processed.

        Args:
            event_id: The event id.
        """
        self._finish(event_id, PROCESSED, "")

    def mark_failed(self, event_id: str, error: str) -> None:
        """Marks an event failed after its attempts are used up.

        Args:
            event_id: The event id.
            error: The last error text.
        """
        self._finish(event_id, FAILED, str(error) or "failed")

    def note_failure(self, event_id: str, error: str, next_attempt_at: int) -> int:
        """Counts a failed handler run and schedules the next attempt.

        Args:
            event_id: The event id.
            error: The error text.
            next_attempt_at: When the outbox may try again (epoch ms).

        Returns:
            How many runs have failed so far, 0 when the event is gone.
        """
        return int(
            self._client.eval(
                _NOTE_FAILURE,
                2,
                self._event_key(event_id),
                self._key_pending,
                event_id,
                str(error),
                str(next_attempt_at),
            )
        )

    def since(self, after_event_id: str | None = None, limit: int | None = None) -> list[dict]:
        """Finished events after a cursor, oldest first.

        Args:
            after_event_id: The last event the caller saw. Unknown ids return the latest events.
            limit: At most this many, capped at 200.

        Returns:
            Public events, replaying from ``REPLAY_OVERLAP_MS`` before the cursor's finish time.
        """
        size = replay_limit(limit)
        start: str = "-inf"
        if after_event_id:
            score = self._client.zscore(self._key_done, after_event_id)
            if score is not None:
                start = str(int(score) - REPLAY_OVERLAP_MS)
        # Newest first, one extra in case the cursor itself is in the window, then flipped to oldest first.
        ids = self._client.zrevrangebyscore(self._key_done, "+inf", start, start=0, num=size + 1)
        ids = [event_id for event_id in ids if event_id != after_event_id][:size]
        events = [event for event in self._load(ids) if event]
        return [public_event(event) for event in reversed(events)]

    def pending(self, limit: int = 10, lease_ms: int = DEFAULT_LEASE_MS) -> list[dict]:
        """Claims received events that are due, leasing them so no other worker takes them.

        Args:
            limit: How many to claim.
            lease_ms: How long the claim lasts.

        Returns:
            The claimed events.
        """
        at = self._now()
        ids = self._client.eval(_CLAIM, 1, self._key_pending, str(at), str(limit), str(at + lease_ms))
        return [event for event in self._load(ids) if event]

    def list_failed(self, limit: int = 50) -> list[dict]:
        """Failed events, newest first.

        Args:
            limit: At most this many.

        Returns:
            The failed events.
        """
        ids = self._client.zrevrange(self._key_failed, 0, limit - 1)
        return [event for event in self._load(ids) if event]

    def replay(self, event_id: str) -> bool:
        """Puts a failed event back to ``received`` so its handlers run again.

        Args:
            event_id: The event id.

        Returns:
            True when the event was failed and is queued again.
        """
        result = self._client.eval(
            _REPLAY,
            4,
            self._event_key(event_id),
            self._key_pending,
            self._key_done,
            self._key_failed,
            event_id,
            str(self._now()),
        )
        return int(result) == 1

    def purge_contact(self, contact_id: str, keep_event_id: str | None = None) -> int:
        """Deletes every stored event about a contact, and scrubs the one that triggered the purge.

        Args:
            contact_id: The contact.
            keep_event_id: The ``contact.deleted`` event itself, kept with its data reduced to the contact id.

        Returns:
            How many events were deleted.
        """
        ids = [i for i in self._client.smembers(self._contact_key(contact_id)) if i != keep_event_id]
        pipe = self._client.pipeline(transaction=False)
        for event_id in ids:
            pipe.delete(self._event_key(event_id))
            pipe.zrem(self._key_pending, event_id)
            pipe.zrem(self._key_done, event_id)
            pipe.zrem(self._key_failed, event_id)
            pipe.srem(self._contact_key(contact_id), event_id)
        if keep_event_id:
            kept = self._client.hget(self._event_key(keep_event_id), "json")
            if kept:
                base = json.loads(kept)
                base["data"] = {"contact_id": contact_id}
                pipe.hset(self._event_key(keep_event_id), "json", json.dumps(base, separators=(",", ":")))
        pipe.execute()
        return len(ids)

    def counts(self) -> dict:
        """Counts events by status.

        Returns:
            ``received``, ``processed``, ``failed`` and ``oldest_received_age_seconds``.
        """
        received = self._client.zcard(self._key_pending)
        finished = self._client.zcard(self._key_done)
        failed = self._client.zcard(self._key_failed)
        out = {
            RECEIVED: received,
            PROCESSED: max(0, finished - failed),
            FAILED: failed,
            "oldest_received_age_seconds": 0,
        }
        earliest = None
        for row in self._load(self._client.zrange(self._key_pending, 0, 19)):
            if row and (earliest is None or row["received_at"] < earliest):
                earliest = row["received_at"]
        if earliest is not None:
            out["oldest_received_age_seconds"] = max(0, round((self._now() - earliest) / 1000))
        return out

    def prune(self) -> int:
        """Deletes finished events older than the retention window.

        Returns:
            How many were deleted.
        """
        cutoff = str(self._now() - self._keep_ms)
        # Failed events are in both sets, so the done count already includes them.
        removed = self._client.zremrangebyscore(self._key_done, "-inf", cutoff)
        self._client.zremrangebyscore(self._key_failed, "-inf", cutoff)
        return int(removed)

    def ready(self) -> bool:
        """Whether the server answers a ping.

        Returns:
            False when the store is not started or the server cannot be reached.
        """
        try:
            return bool(self._client is not None and self._client.ping())
        except Exception:  # noqa: BLE001 - any client error means not ready
            return False

    def close(self) -> None:
        """Closes the connection pool (a client passed in by a test is left open)."""
        if self._client is not None and self._owns_client:
            self._client.close()
            self._client = None


def create(ctx: Any, now: Callable[[], int] | None = None, client: Any = None) -> RedisStore:
    """Creates the store; the client connects in ``start()``.

    Args:
        ctx: The provider context (config and merged env).
        now: Clock in epoch milliseconds, replaced in tests.
        client: A ready client, for tests.

    Returns:
        The store instance.
    """
    return RedisStore(ctx.config, ctx.env, now, client)
