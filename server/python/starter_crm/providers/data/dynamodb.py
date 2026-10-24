"""The ``dynamodb`` data provider: module documents in the same DynamoDB table as the event store.

Where it sits: ``DC_DATA=dynamodb``, which is also what ``DC_STORE=dynamodb`` selects. It shares the table, the
credentials and the region with ``store/dynamodb.py``, so an AWS deployment needs one table and one IAM policy. The
Node server has the same provider (``src/providers/data/dynamodb.js``) and the same layout, so the two can share one
table.

How documents are laid out:

- the document: ``pk = M#<site>#<owner>#<collection>``, ``sk = <id>``, its fields in a native map ``f`` (so a number
  stays a number and a filter on ``true`` never matches ``"true"``), plus ``owner_id``, ``created_at``, ``updated_at``;
- a pointer, ``pk = MI#<site>#<collection>#<id>``, ``sk = i``, holding the owner, written in the same transaction, so
  the system view (which has no owner) finds a document by id with two strongly consistent reads;
- the index ``gsi1`` (``gsi1pk = M#<site>#<collection>``, ``gsi1sk = <created_at>#<id>``) lists a collection across
  owners, newest first, for the system view.

Site and owner ids are URL-encoded where they sit in a key, so a ``#`` in one can never be read as a separator.

Limits, which suit a starter and are worth knowing:

- A scoped ``list()`` reads the owner's whole collection (a strongly consistent query), filters it here and sorts it
  newest first, so it is meant for up to a few thousand documents per owner and collection. For more, add an index on
  your filter field to the table and query it from your own provider.
- The system view's ``list()`` goes through ``gsi1``, which is eventually consistent (milliseconds): a document
  written an instant ago may not be listed yet. Each listed document is re-read consistently, so its fields are never
  stale.
- An item is at most 400 KB.

CONTRACT.md: "Module data".
Env: AWS_REGION, AWS_ENDPOINT_URL, DC_DYNAMODB_TABLE, DC_DYNAMODB_AUTO_CREATE. What a customer changes: nothing.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Mapping
from typing import Any
from urllib.parse import quote

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
from ..store.common import site_key
from .common import Views, new_id, same_type_equal, to_document

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
    return [*validate_aws(env, "DC_DATA=dynamodb", "DYNAMODB"), *validate_table(env)]


def _encode(value: str) -> str:
    """Makes an id safe to sit between ``#`` separators (the same escaping as JavaScript's encodeURIComponent)."""
    return quote(value, safe="-_.!~*'()")


def _from_item(item: dict) -> dict:
    """Turns a stored item into a document.

    Args:
        item: The DynamoDB item.

    Returns:
        The document.
    """
    return to_document(
        {
            "id": item["sk"],
            "owner_id": item["owner_id"],
            "created_at": int(item["created_at"]),
            "updated_at": int(item["updated_at"]),
        },
        item["f"],
    )


def _condition_failed(err: BaseException) -> bool:
    """Whether an error is a write whose condition did not hold (a transaction cancelled for that reason too)."""
    return error_code(err) in ("TransactionCanceledException", "ConditionalCheckFailedException")


class _Rows:
    """The row operations, over a DynamoDB client."""

    def __init__(
        self,
        config: Any,
        env: Mapping[str, str],
        now: Callable[[], int],
        client: DynamoClient | None = None,
    ):
        """Prepares the operations; nothing connects until ``open()``.

        Args:
            config: The loaded config (site id).
            env: The merged environment (region, endpoint, table).
            now: Clock in epoch milliseconds.
            client: A ready ``DynamoClient`` (tests); it is not closed here.
        """
        self._now = now
        self._site = _encode(site_key(config))
        self._env = env
        self.client = client
        self._owns_client = client is None

    def open(self) -> None:
        """Connects and makes sure the table exists. Safe to call twice."""
        if self.client is None:
            self.client = connect_dynamo(self._env)
        self.client.ensure_table(auto_create(self._env))

    def _partition(self, collection: str, owner: str) -> str:
        return "M#" + self._site + "#" + _encode(owner) + "#" + collection

    def _pointer(self, collection: str, doc_id: str) -> str:
        return "MI#" + self._site + "#" + collection + "#" + _encode(doc_id)

    def _index(self, collection: str) -> str:
        return "M#" + self._site + "#" + collection

    def _owner_of(self, collection: str, doc_id: str) -> str | None:
        """Finds the owner of a document, for the system view."""
        item = self.client.get({"pk": self._pointer(collection, doc_id), "sk": "i"})
        return item["owner_id"] if item else None

    def _read_item(self, collection: str, owner: str | None, doc_id: str) -> dict | None:
        """Reads one item the caller may see (strongly consistent)."""
        actual = self._owner_of(collection, doc_id) if owner is None else owner
        if actual is None:
            return None
        return self.client.get({"pk": self._partition(collection, actual), "sk": doc_id})

    def insert(self, collection: str, owner: str, fields: dict) -> dict:
        """Adds a document.

        Args:
            collection: The collection.
            owner: The owner id.
            fields: The checked fields.

        Returns:
            The stored document.
        """
        at = self._now()
        doc_id = new_id()
        item = {
            "pk": self._partition(collection, owner),
            "sk": doc_id,
            "owner_id": owner,
            "created_at": at,
            "updated_at": at,
            "f": fields,
            "gsi1pk": self._index(collection),
            "gsi1sk": pad(at) + "#" + doc_id,
        }
        self.client.transact(
            [
                {"put": item, "condition": "attribute_not_exists(pk)"},
                {
                    "put": {"pk": self._pointer(collection, doc_id), "sk": "i", "owner_id": owner},
                    "condition": "attribute_not_exists(pk)",
                },
            ]
        )
        return _from_item(item)

    def get(self, collection: str, owner: str | None, doc_id: str) -> dict | None:
        """Reads a document.

        Args:
            collection: The collection.
            owner: The owner to limit to, or None for any.
            doc_id: The document id.

        Returns:
            The document, or None when it is missing or another owner's.
        """
        item = self._read_item(collection, owner, doc_id)
        return _from_item(item) if item else None

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

        def matches(item: dict) -> bool:
            return all(key in item["f"] and same_type_equal(item["f"][key], value) for key, value in where)

        def newest_first(item: dict) -> tuple[int, str]:
            return (int(item["created_at"]), item["sk"])

        found: list[dict] = []
        if owner is not None:
            items = self.client.query("pk = :p", {":p": self._partition(collection, owner)}, consistent=True)
            found = [item for item in items if matches(item)]
        else:
            # Across owners: walk the index newest first, re-read each page consistently, and stop at ``limit`` matches.
            start: dict | None = None
            while True:
                entries, start = self.client.query_page(
                    "gsi1pk = :p", {":p": self._index(collection)}, "gsi1", forward=False, start=start
                )
                fresh = self.client.batch_get([{"pk": entry["pk"], "sk": entry["sk"]} for entry in entries])
                for entry in entries:
                    item = fresh.get((entry["pk"], entry["sk"]))
                    if item and matches(item):
                        found.append(item)
                if not start or len(found) >= limit:
                    break
        found.sort(key=newest_first, reverse=True)
        return [_from_item(item) for item in found[:limit]]

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
        item = self._read_item(collection, owner, doc_id)
        if not item:
            return None
        names = {"#f": "f", "#u": "updated_at"}
        values: dict[str, Any] = {":u": max(self._now(), int(item["created_at"]))}
        sets = ["#u = :u"]
        for i, (key, value) in enumerate(patch.items()):
            names["#k" + str(i)] = key
            values[":v" + str(i)] = value
            sets.append("#f.#k" + str(i) + " = :v" + str(i))
        try:
            attributes = self.client.update(
                {"pk": item["pk"], "sk": doc_id},
                "SET " + ", ".join(sets),
                names,
                values,
                condition="attribute_exists(pk)",
                return_values="ALL_NEW",
            )
        except Exception as err:  # noqa: BLE001 - only "removed in between" is handled
            if _condition_failed(err):
                return None
            raise
        return _from_item(attributes)

    def remove(self, collection: str, owner: str | None, doc_id: str) -> bool:
        """Deletes a document.

        Args:
            collection: The collection.
            owner: The owner to limit to, or None for any.
            doc_id: The document id.

        Returns:
            True when a document was deleted.
        """
        item = self._read_item(collection, owner, doc_id)
        if not item:
            return False
        try:
            self.client.transact(
                [
                    {"delete": {"pk": item["pk"], "sk": doc_id}, "condition": "attribute_exists(pk)"},
                    {"delete": {"pk": self._pointer(collection, doc_id), "sk": "i"}},
                ]
            )
            return True
        except Exception as err:  # noqa: BLE001 - only "removed in between" is handled
            if _condition_failed(err):
                return False
            raise

    def ready(self) -> bool:
        """Whether the table answers.

        Returns:
            False when the provider is not started or the table cannot be reached.
        """
        return self.client is not None and self.client.table_active()

    def close(self) -> None:
        """Closes the client (one passed in by a test is left open)."""
        if self.client is not None and self._owns_client:
            self.client.raw.close()
            self.client = None


class DynamoData(Views):
    """The provider: ``scope()`` and ``system()`` over the DynamoDB row operations."""

    def __init__(
        self,
        config: Any,
        env: Mapping[str, str],
        now: Callable[[], int] | None = None,
        client: DynamoClient | None = None,
    ):
        """Prepares the provider; nothing connects until ``start()``.

        Args:
            config: The loaded config.
            env: The merged environment.
            now: Clock in epoch milliseconds, replaced in tests.
            client: A ready client, for tests.
        """
        self._dynamo = _Rows(config, env, now or (lambda: int(time.time() * 1000)), client)
        super().__init__(self._dynamo)

    def start(self) -> None:
        """Connects and makes sure the table exists. Safe to call twice."""
        self._dynamo.open()

    def ready(self) -> bool:
        """Whether the table answers.

        Returns:
            False when the provider is not started or the table cannot be reached.
        """
        return self._dynamo.ready()

    def close(self) -> None:
        """Closes the client."""
        self._dynamo.close()


def create(ctx: Any, now: Callable[[], int] | None = None, client: DynamoClient | None = None) -> DynamoData:
    """Creates the provider; the client connects in ``start()``.

    Args:
        ctx: The provider context (config and merged env).
        now: Clock in epoch milliseconds, replaced in tests.
        client: A ready client, for tests.

    Returns:
        The provider instance.
    """
    return DynamoData(ctx.config, ctx.env, now, client)
