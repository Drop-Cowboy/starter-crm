"""The ``dynamodb`` event store: events in one DynamoDB table every instance shares.

Where it sits: ``DC_STORE=dynamodb``, the store for AWS (the ECS Express template creates the table). It suits hosts
with no SQL database, and any number of servers and workers can record, claim and replay against the same table. boto3
finds its credentials itself (the ECS task role); ``AWS_REGION`` says where the table is, and ``AWS_ENDPOINT_URL``
points at a local stand-in such as dynamodb-local. The Node server uses the same table layout, so the two can share one
table.

How events are laid out (one site's events share one partition; a starter is not a firehose):

- the event itself: ``pk = E#<site>``, ``sk = <event_id>``, with the public event as a JSON string, its status,
  attempt count, retry time and error;
- the index ``gsi1`` orders them by state: partition ``R#<site>`` holds events waiting for a handler, sorted by when
  they are next due; ``D#<site>`` holds processed events and ``X#<site>`` failed ones, both sorted by when they
  finished (that order is replay);
- the index ``gsi2`` groups a contact's events (``C#<site>#<contact_id>``), so ``contact.deleted`` can erase them.

An event is in exactly one state partition, so moving it is one update.

Index reads are eventually consistent (usually within a few milliseconds). That is fine here: the outbox polls, replay
overlaps by 5 seconds, and ``pending()`` claims each event with a conditional write, so a stale read can only make a
worker skip an event until its next poll, never run it twice. Finished events carry ``expires_at``, so DynamoDB's own
time-to-live removes stragglers, and ``prune()`` removes them on time.

An item is at most 400 KB, so an event whose JSON is larger cannot be recorded (the webhook answers
``503 webhook_not_queued`` and Drop Cowboy retries). Drop Cowboy's events are far smaller.

CONTRACT.md: "Event store".
Env: AWS_REGION, AWS_ENDPOINT_URL, DC_DYNAMODB_TABLE, DC_DYNAMODB_AUTO_CREATE. What a customer changes: nothing.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Mapping
from typing import Any

from ...aws_util import (
    DynamoClient,
    auto_create,
    connect_dynamo,
    error_code,
    pad,
    validate_aws,
    validate_table,
)
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

name = "dynamodb"
config_keys = [
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_ENDPOINT_URL",
    "AWS_ENDPOINT_URL_DYNAMODB",
    "DC_DYNAMODB_TABLE",
    "DC_DYNAMODB_AUTO_CREATE",
]


def validate(env: Mapping[str, str]) -> list[BootProblem]:
    """Checks the region, the endpoint and the table name.

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    return [*validate_aws(env, "DC_STORE=dynamodb", "DYNAMODB"), *validate_table(env)]


def _from_item(item: dict | None) -> dict | None:
    """Turns a stored item into the event dict every store returns.

    Args:
        item: The DynamoDB item.

    Returns:
        The event with ``status``, ``attempts``, ``next_attempt_at``, ``last_error`` and ``done_at``; None for no item.
    """
    if not item or not isinstance(item.get("json"), str):
        return None
    base = json.loads(item["json"])
    return {
        "event_id": base["event_id"],
        "event": base["event"],
        "event_at": base["event_at"],
        "received_at": base["received_at"],
        "attempt": base["attempt"],
        "data": base["data"],
        "contact_id": item.get("contact_id"),
        "status": item["status"],
        "attempts": int(item["attempts"]),
        "next_attempt_at": int(item["next_attempt_at"]),
        "last_error": item.get("last_error"),
        "done_at": int(item["done_at"]) if item.get("done_at") is not None else None,
    }


class DynamoStore:
    """An event store in DynamoDB."""

    def __init__(
        self,
        config: Any,
        env: Mapping[str, str],
        now: Callable[[], int] | None = None,
        client: DynamoClient | None = None,
    ):
        """Prepares the store. The client connects in ``start()``, so creating the store is safe before a fork.

        Args:
            config: The loaded config (site id, retention).
            env: The merged environment (region, endpoint, table).
            now: Clock in epoch milliseconds, replaced in tests.
            client: A ready ``DynamoClient`` (tests); it is not closed by the store.
        """
        self._now = now or (lambda: int(time.time() * 1000))
        self._keep_ms = retention_ms(config)
        self._site = site_key(config)
        self._env = env
        self._client = client
        self._owns_client = client is None
        self._pk = "E#" + self._site
        self._partition = {RECEIVED: "R#" + self._site, PROCESSED: "D#" + self._site, FAILED: "X#" + self._site}

    def start(self) -> None:
        """Connects and makes sure the table exists. Safe to call twice."""
        if self._client is None:
            self._client = connect_dynamo(self._env)
        self._client.ensure_table(auto_create(self._env))

    def _get_event(self, event_id: str) -> dict | None:
        """Reads one event, hiding one whose time-to-live has passed but DynamoDB has not yet removed."""
        item = self._client.get({"pk": self._pk, "sk": event_id})
        if item and item.get("expires_at") is not None and int(item["expires_at"]) * 1000 <= self._now():
            return None
        return _from_item(item)

    def _finish(self, event_id: str, status: str, error: str | None) -> None:
        """Moves an event to a finished state."""
        at = self._now()
        names = {"#s": "status", "#d": "done_at", "#p": "gsi1pk", "#k": "gsi1sk", "#x": "expires_at"}
        values: dict[str, Any] = {
            ":s": status,
            ":d": at,
            ":p": self._partition[FAILED if status == FAILED else PROCESSED],
            ":k": pad(at) + "#" + event_id,
            ":x": (at + self._keep_ms) // 1000,
        }
        expression = "SET #s = :s, #d = :d, #p = :p, #k = :k, #x = :x"
        if error is not None:
            names["#e"] = "last_error"
            values[":e"] = error or "failed"
            expression += ", #e = :e"
        try:
            self._client.update(
                {"pk": self._pk, "sk": event_id}, expression, names, values, condition="attribute_exists(pk)"
            )
        except Exception as err:  # noqa: BLE001 - only a missing event is ignored
            if error_code(err) != "ConditionalCheckFailedException":
                raise

    def record(self, event: dict, visible_at: int | None = None) -> dict:
        """Stores a new event as ``received``, unless its id is already stored.

        Args:
            event: ``event_id``, ``event``, ``event_at``, ``received_at``, ``attempt`` and ``data``.
            visible_at: When the outbox may first pick the event up (epoch ms); now by default.

        Returns:
            ``{"inserted": bool, "status": str}``.
        """
        due = visible_at if visible_at is not None else self._now()
        contact_id = contact_id_of(event["data"])
        item: dict[str, Any] = {
            "pk": self._pk,
            "sk": event["event_id"],
            "json": json.dumps(public_event(event), separators=(",", ":")),
            "status": RECEIVED,
            "attempts": 0,
            "next_attempt_at": due,
            "received_at": event["received_at"],
            "gsi1pk": self._partition[RECEIVED],
            "gsi1sk": pad(due) + "#" + event["event_id"],
        }
        if contact_id:
            item["contact_id"] = contact_id
            item["gsi2pk"] = "C#" + self._site + "#" + contact_id
            item["gsi2sk"] = event["event_id"]
        try:
            self._client.put(item, condition="attribute_not_exists(pk)")
            return {"inserted": True, "status": RECEIVED}
        except Exception as err:  # noqa: BLE001 - only a duplicate id is handled
            if error_code(err) != "ConditionalCheckFailedException":
                raise
            existing = self._get_event(event["event_id"])
            return {"inserted": False, "status": existing["status"] if existing else RECEIVED}

    def get(self, event_id: str) -> dict | None:
        """Reads one event.

        Args:
            event_id: The event id.

        Returns:
            The stored event, or None when it does not exist or has expired.
        """
        return self._get_event(event_id)

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
        key = {"pk": self._pk, "sk": event_id}
        try:
            # An event still waiting moves to its new due time in the outbox index too.
            result = self._client.update(
                key,
                "ADD attempts :one SET last_error = :e, next_attempt_at = :n, gsi1sk = :k",
                {"#s": "status"},
                {
                    ":one": 1,
                    ":e": str(error),
                    ":n": next_attempt_at,
                    ":k": pad(next_attempt_at) + "#" + event_id,
                    ":received": RECEIVED,
                },
                condition="#s = :received",
                return_values="UPDATED_NEW",
            )
            return int(result["attempts"])
        except Exception as err:  # noqa: BLE001 - a finished or missing event falls through to the second update
            if error_code(err) != "ConditionalCheckFailedException":
                raise
        try:
            result = self._client.update(
                key,
                "ADD attempts :one SET last_error = :e, next_attempt_at = :n",
                None,
                {":one": 1, ":e": str(error), ":n": next_attempt_at},
                condition="attribute_exists(pk)",
                return_values="UPDATED_NEW",
            )
            return int(result["attempts"])
        except Exception as err:  # noqa: BLE001 - only a missing event is handled
            if error_code(err) == "ConditionalCheckFailedException":
                return 0
            raise

    def since(self, after_event_id: str | None = None, limit: int | None = None) -> list[dict]:
        """Finished events after a cursor, oldest first.

        Args:
            after_event_id: The last event the caller saw. Unknown ids return the latest events.
            limit: At most this many, capped at 200.

        Returns:
            Public events, replaying from ``REPLAY_OVERLAP_MS`` before the cursor's finish time.
        """
        size = replay_limit(limit)
        # An index key cannot be an empty string; "0" sorts before every 13-digit time.
        start = "0"
        if after_event_id:
            cursor = self._get_event(after_event_id)
            if cursor and cursor["done_at"] is not None:
                start = pad(cursor["done_at"] - REPLAY_OVERLAP_MS)
        window: list[dict] = []
        # Processed and failed events sit in two partitions; the newest ``size + 1`` of each is enough to find
        # the newest ``size`` of both.
        for index_pk in (self._partition[PROCESSED], self._partition[FAILED]):
            items = self._client.query(
                "gsi1pk = :p AND gsi1sk >= :f",
                {":p": index_pk, ":f": start},
                index="gsi1",
                forward=False,
                limit=size + 1,
            )
            for item in items:
                event = _from_item(item)
                if event and event["event_id"] != after_event_id:
                    window.append(event)
        window.sort(key=lambda e: (e["done_at"], e["event_id"]))
        return [public_event(event) for event in window[-size:]]

    def pending(self, limit: int = 10, lease_ms: int = DEFAULT_LEASE_MS) -> list[dict]:
        """Claims received events that are due, leasing them so no other worker takes them.

        Args:
            limit: How many to claim.
            lease_ms: How long the claim lasts.

        Returns:
            The claimed events.
        """
        at = self._now()
        due = self._client.query(
            "gsi1pk = :p AND gsi1sk <= :c",
            {":p": self._partition[RECEIVED], ":c": pad(at) + "#~"},
            index="gsi1",
            limit=limit,
        )
        claimed: list[dict] = []
        for item in due:
            event_id = item["sk"]
            try:
                # The index read may be a moment stale, so the claim only succeeds if the event is still due as the
                # read saw it.
                result = self._client.update(
                    {"pk": self._pk, "sk": event_id},
                    "SET next_attempt_at = :u, gsi1sk = :k",
                    {"#s": "status"},
                    {
                        ":u": at + lease_ms,
                        ":k": pad(at + lease_ms) + "#" + event_id,
                        ":received": RECEIVED,
                        ":old": int(item["next_attempt_at"]),
                    },
                    condition="#s = :received AND next_attempt_at = :old",
                    return_values="ALL_NEW",
                )
            except Exception as err:  # noqa: BLE001 - another worker won the claim
                if error_code(err) != "ConditionalCheckFailedException":
                    raise
                continue
            event = _from_item(result)
            if event:
                claimed.append(event)
        return claimed

    def list_failed(self, limit: int = 50) -> list[dict]:
        """Failed events, newest first.

        Args:
            limit: At most this many.

        Returns:
            The failed events.
        """
        items = self._client.query(
            "gsi1pk = :p", {":p": self._partition[FAILED]}, index="gsi1", forward=False, limit=limit
        )
        return [event for event in (_from_item(item) for item in items) if event]

    def replay(self, event_id: str) -> bool:
        """Puts a failed event back to ``received`` so its handlers run again.

        Args:
            event_id: The event id.

        Returns:
            True when the event was failed and is queued again.
        """
        at = self._now()
        try:
            self._client.update(
                {"pk": self._pk, "sk": event_id},
                "SET #s = :received, attempts = :zero, next_attempt_at = :n, gsi1pk = :p, gsi1sk = :k "
                "REMOVE done_at, expires_at",
                {"#s": "status"},
                {
                    ":received": RECEIVED,
                    ":failed": FAILED,
                    ":zero": 0,
                    ":n": at,
                    ":p": self._partition[RECEIVED],
                    ":k": pad(at) + "#" + event_id,
                },
                condition="#s = :failed",
            )
            return True
        except Exception as err:  # noqa: BLE001 - only "not failed" is handled
            if error_code(err) == "ConditionalCheckFailedException":
                return False
            raise

    def purge_contact(self, contact_id: str, keep_event_id: str | None = None) -> int:
        """Deletes every stored event about a contact, and scrubs the one that triggered the purge.

        Args:
            contact_id: The contact.
            keep_event_id: The ``contact.deleted`` event itself, kept with its data reduced to the contact id.

        Returns:
            How many events were deleted.
        """
        items = self._client.query("gsi2pk = :p", {":p": "C#" + self._site + "#" + contact_id}, index="gsi2")
        doomed = [item for item in items if item["sk"] != keep_event_id]
        self._client.delete_keys([{"pk": item["pk"], "sk": item["sk"]} for item in doomed])
        kept = next((item for item in items if item["sk"] == keep_event_id), None) if keep_event_id else None
        if kept:
            base = json.loads(kept["json"])
            base["data"] = {"contact_id": contact_id}
            self._client.update(
                {"pk": self._pk, "sk": keep_event_id},
                "SET json = :j",
                None,
                {":j": json.dumps(base, separators=(",", ":"))},
            )
        return len(doomed)

    def counts(self) -> dict:
        """Counts events by status.

        Returns:
            ``received``, ``processed``, ``failed`` and ``oldest_received_age_seconds``.
        """

        def count(index_pk: str) -> int:
            return int(
                self._client.query("gsi1pk = :p", {":p": index_pk}, index="gsi1", count_only=True)  # type: ignore[arg-type]
            )

        out = {
            RECEIVED: count(self._partition[RECEIVED]),
            PROCESSED: count(self._partition[PROCESSED]),
            FAILED: count(self._partition[FAILED]),
            "oldest_received_age_seconds": 0,
        }
        oldest = self._client.query("gsi1pk = :p", {":p": self._partition[RECEIVED]}, index="gsi1", limit=20)
        earliest = None
        for item in oldest:
            received_at = int(item["received_at"])
            if earliest is None or received_at < earliest:
                earliest = received_at
        if earliest is not None:
            out["oldest_received_age_seconds"] = max(0, round((self._now() - earliest) / 1000))
        return out

    def prune(self) -> int:
        """Deletes finished events older than the retention window.

        Returns:
            How many were deleted.
        """
        cutoff = pad(self._now() - self._keep_ms)
        removed = 0
        for index_pk in (self._partition[PROCESSED], self._partition[FAILED]):
            old = self._client.query("gsi1pk = :p AND gsi1sk < :c", {":p": index_pk, ":c": cutoff}, index="gsi1")
            self._client.delete_keys([{"pk": item["pk"], "sk": item["sk"]} for item in old])
            removed += len(old)
        return removed

    def ready(self) -> bool:
        """Whether the table answers.

        Returns:
            False when the store is not started or the table cannot be reached.
        """
        return self._client is not None and self._client.table_active()

    def close(self) -> None:
        """Closes the client (one passed in by a test is left open)."""
        if self._client is not None and self._owns_client:
            self._client.raw.close()
            self._client = None


def create(ctx: Any, now: Callable[[], int] | None = None, client: DynamoClient | None = None) -> DynamoStore:
    """Creates the store; the client connects in ``start()``.

    Args:
        ctx: The provider context (config and merged env).
        now: Clock in epoch milliseconds, replaced in tests.
        client: A ready client, for tests.

    Returns:
        The store instance.
    """
    return DynamoStore(ctx.config, ctx.env, now, client)
