"""The ``memory`` data provider: module documents live in this process and vanish on restart.

Where it sits: ``DC_DATA=memory``, which is also what ``DC_STORE=memory`` (the default) selects. Nothing to
install, and the data API behaves exactly as it will on a database, so you can build a module against it and
move to ``sqlite`` or ``postgres`` by changing one setting. It cannot be shared between instances. Requests run
on several threads, so every operation takes one lock.

The data interface (every provider, built-in or yours, implements it):

- ``scope(owner_id)`` returns a view whose ``collection(name)`` only ever sees that owner's documents.
- ``system()`` returns a view over every owner of the site, for event handlers.
- A collection has ``insert(fields)``, ``get(id)``, ``list(where=None, limit=None)``, ``update(id, patch)`` and
  ``remove(id)``. A document is ``{"id", "owner_id", "created_at", "updated_at", **your fields}``. ``get`` returns
  None for a missing document, and also for another owner's: a module cannot tell the two apart.
- ``ready()``, ``close()`` and (SQL providers) ``applied_migrations()``; ``start()`` when the provider needs to
  connect (it is called once, in the process that serves, never before Gunicorn forks).

The Node server has the same interface (``src/providers/data/memory.js``).

CONTRACT.md: "Module data".
What a customer changes: nothing; to keep documents across restarts set ``DC_DATA``.
"""

from __future__ import annotations

import copy
import threading
import time
from collections.abc import Callable
from typing import Any

from ...problems import BootProblem
from .common import Views, new_id, same_type_equal, to_document

name = "memory"
config_keys: list[str] = []


def validate(env: Any) -> list[BootProblem]:
    """Nothing to configure.

    Args:
        env: The merged environment (unused).

    Returns:
        No problems.
    """
    return []


class _Rows:
    """The row operations: documents held in dicts, safe to share between threads."""

    def __init__(self, now: Callable[[], int] | None = None):
        """Creates an empty provider.

        Args:
            now: Clock in epoch milliseconds, replaced in tests.
        """
        self._now = now or (lambda: int(time.time() * 1000))
        self._lock = threading.RLock()
        # collection name -> id -> row. One process serves one site, so the site is not part of the key here.
        self._tables: dict[str, dict[str, dict]] = {}

    def _table(self, collection: str) -> dict[str, dict]:
        """Finds or makes the table for a collection.

        Args:
            collection: The collection name.

        Returns:
            Its rows by id.
        """
        return self._tables.setdefault(collection, {})

    def _visible(self, collection: str, owner: str | None, doc_id: str) -> dict | None:
        """Reads a row the caller may see.

        Args:
            collection: The collection.
            owner: The owner to limit to, or None for any.
            doc_id: The document id.

        Returns:
            The row, or None when it is missing or another owner's.
        """
        row = self._table(collection).get(doc_id)
        return row if row is not None and (owner is None or row["owner_id"] == owner) else None

    @staticmethod
    def _document(row: dict) -> dict:
        """Builds the document a module sees, as a copy so callers cannot change what is stored.

        Args:
            row: A stored row.

        Returns:
            The document.
        """
        return to_document(row, copy.deepcopy(row["fields"]))

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
            row = {"id": new_id(), "owner_id": owner, "created_at": at, "updated_at": at, "fields": fields}
            self._table(collection)[row["id"]] = row
            return self._document(row)

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
            return self._document(row) if row else None

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
        with self._lock:
            found = [
                row
                for row in self._table(collection).values()
                if (owner is None or row["owner_id"] == owner)
                and all(key in row["fields"] and same_type_equal(row["fields"][key], value) for key, value in where)
            ]
            found.sort(key=lambda row: (row["created_at"], row["id"]), reverse=True)
            return [self._document(row) for row in found[:limit]]

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
            row = self._visible(collection, owner, doc_id)
            if row is None:
                return None
            row["fields"].update(copy.deepcopy(patch))
            # Never earlier than the creation time, even when the clock steps back.
            row["updated_at"] = max(self._now(), row["created_at"])
            return self._document(row)

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
            del self._table(collection)[doc_id]
            return True

    def clear(self) -> None:
        """Forgets every document."""
        with self._lock:
            self._tables.clear()


class MemoryData(Views):
    """The provider: ``scope()`` and ``system()`` over the row operations above."""

    def __init__(self, now: Callable[[], int] | None = None):
        """Creates an empty provider.

        Args:
            now: Clock in epoch milliseconds, replaced in tests.
        """
        self._memory = _Rows(now)
        super().__init__(self._memory)

    def ready(self) -> bool:
        """Always ready: there is nothing to connect to.

        Returns:
            True.
        """
        return True

    def close(self) -> None:
        """Forgets every document."""
        self._memory.clear()


def create(ctx: Any, now: Callable[[], int] | None = None) -> MemoryData:
    """Creates the provider.

    Args:
        ctx: The provider context (unused).
        now: Clock in epoch milliseconds, replaced in tests.

    Returns:
        The provider instance.
    """
    return MemoryData(now)
