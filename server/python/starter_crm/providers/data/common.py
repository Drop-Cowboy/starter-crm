"""Helpers every module-data provider shares, so the built-in providers (and yours) agree.

Where it sits: ``memory``, ``sqlite`` and ``postgres`` import these. The rules live in one place on
purpose: a provider that disagreed about which field names are allowed, or how a list is ordered, would
pass its own tests and still behave differently from the others when a customer changes ``DC_DATA``. The
Node server has the same file (``src/providers/data/common.js``).

CONTRACT.md: "Module data".
What a customer changes: nothing; when you write your own data provider, import these instead of
re-deriving them.
"""

from __future__ import annotations

import json
import math
import re
import uuid
from datetime import UTC, datetime
from typing import Any

# What a collection name or a ``where`` field name may look like. Field names go into SQL paths, so they are strict.
_NAME = re.compile(r"[a-z][a-z0-9_]{0,63}")

# The fields the data API owns. A module cannot set them, so a document's id, owner and times can be trusted.
RESERVED_FIELDS = ("id", "owner_id", "created_at", "updated_at")

# The most documents one ``list()`` returns, and what it returns when no limit is given.
LIST_MAX = 500
LIST_DEFAULT = 100

# The methods a custom ``DC_DATA`` provider's instance must have; boot checks for them.
DATA_METHODS = ("scope", "system", "ready", "close")


def new_id() -> str:
    """Makes a new document id.

    Returns:
        A random UUID string, with no prefix.
    """
    return str(uuid.uuid4())


def check_collection(name: Any) -> str:
    """Checks a collection name.

    Args:
        name: What the module passed to ``collection()``.

    Returns:
        The same name.

    Raises:
        ValueError: When it is not lowercase letters, digits and underscores, starting with a letter.
    """
    if not isinstance(name, str) or _NAME.fullmatch(name) is None:
        raise ValueError(
            "A collection name is lowercase letters, digits and underscores, starting with a letter (got "
            + json.dumps(name)
            + ")."
        )
    return name


def check_fields(fields: Any, allowed: tuple[str, ...] = ()) -> dict:
    """Checks the fields of a new document or an update.

    Args:
        fields: What the module passed to ``insert()`` or ``update()``.
        allowed: Reserved names the caller may include (the system view sets ``owner_id`` itself).

    Returns:
        A copy that survives a JSON round trip unchanged.

    Raises:
        ValueError: When it is not a dict, or sets a field only the data API may set.
    """
    if not isinstance(fields, dict):
        raise ValueError("A document is a plain dict.")
    for key in fields:
        if key in RESERVED_FIELDS and key not in allowed:
            raise ValueError('"' + str(key) + '" is set by the data API; leave it out of the document.')
    return json.loads(json.dumps(fields))


def check_where(where: Any) -> list[tuple[str, Any]]:
    """Checks a ``where`` filter: safe field names, and values that are strings, numbers or booleans.

    Args:
        where: The filter, or None for none.

    Returns:
        The ``(field, value)`` pairs to match, in the order given.

    Raises:
        ValueError: For an unsafe field name, or a value that is not a string, finite number or boolean.
    """
    if where is None:
        return []
    if not isinstance(where, dict):
        raise ValueError("`where` is a dict of field: value pairs.")
    out = []
    for key, value in where.items():
        if not isinstance(key, str) or _NAME.fullmatch(key) is None or key in RESERVED_FIELDS:
            raise ValueError(
                'Cannot filter on "'
                + str(key)
                + '": use a document field name in lowercase letters, digits and underscores.'
            )
        is_number = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
        if not (isinstance(value, (str, bool)) or is_number):
            raise ValueError('Filter "' + key + '" must be a string, a number or a boolean.')
        out.append((key, value))
    return out


def list_limit(limit: Any) -> int:
    """Clamps a list limit.

    Args:
        limit: What the module asked for.

    Returns:
        A whole number from 1 to ``LIST_MAX``; ``LIST_DEFAULT`` when unset or invalid.
    """
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        return LIST_DEFAULT
    return min(limit, LIST_MAX)


def iso_time(ms: int) -> str:
    """Writes an epoch time the way documents show it.

    Args:
        ms: Epoch milliseconds.

    Returns:
        ISO 8601 in UTC with milliseconds, such as ``2026-10-13T12:00:00.000Z``.
    """
    stamp = datetime.fromtimestamp(int(ms) / 1000, tz=UTC)
    return stamp.strftime("%Y-%m-%dT%H:%M:%S.") + format(int(ms) % 1000, "03d") + "Z"


def to_document(row: dict, fields: dict) -> dict:
    """Builds the document a module sees from a stored row.

    Args:
        row: The columns ``id``, ``owner_id``, ``created_at`` and ``updated_at``.
        fields: The JSON the module stored.

    Returns:
        ``id``, ``owner_id``, ``created_at`` and ``updated_at`` first, then the module's fields.
    """
    document = {
        "id": row["id"],
        "owner_id": row["owner_id"],
        "created_at": iso_time(row["created_at"]),
        "updated_at": iso_time(row["updated_at"]),
    }
    # The module's fields cannot be listed here, so they are copied after the four the data API owns.
    document.update(fields)
    return document


class _Collection:
    """One collection as one owner (or, in the system view, every owner) sees it."""

    def __init__(self, rows: Any, name: str, owner: str | None):
        """Binds a collection to its row operations and its owner.

        Args:
            rows: The provider's row operations, each taking ``(collection, owner, ...)``.
            name: The collection name, already checked.
            owner: The owner every operation is limited to, or None for the system view.
        """
        self._rows = rows
        self._name = name
        self._owner = owner

    def insert(self, fields: dict) -> dict:
        """Adds a document.

        Args:
            fields: The document's fields. In the system view they must include ``owner_id``.

        Returns:
            The stored document, with its new ``id`` and times.

        Raises:
            ValueError: When a reserved field is set, or the system view has no ``owner_id``.
        """
        clean = check_fields(fields, ("owner_id",) if self._owner is None else ())
        owner = clean.get("owner_id") if self._owner is None else self._owner
        if not isinstance(owner, str) or owner == "":
            raise ValueError("A document in the system view needs an owner_id.")
        clean.pop("owner_id", None)
        return self._rows.insert(self._name, owner, clean)

    def get(self, doc_id: str) -> dict | None:
        """Reads one document.

        Args:
            doc_id: The document id.

        Returns:
            The document, or None when it is missing or another owner's (the two look the same).
        """
        return self._rows.get(self._name, self._owner, str(doc_id))

    def list(self, where: dict | None = None, limit: int | None = None) -> list[dict]:
        """Lists documents, newest first.

        Args:
            where: Fields that must equal these values (strings, numbers or booleans).
            limit: How many to return (default 100, at most 500).

        Returns:
            The documents.
        """
        return self._rows.list(self._name, self._owner, check_where(where), list_limit(limit))

    def update(self, doc_id: str, patch: dict) -> dict | None:
        """Changes some fields of a document, leaving the others as they are.

        Args:
            doc_id: The document id.
            patch: The fields to set.

        Returns:
            The updated document, or None when it is missing or another owner's.
        """
        return self._rows.update(self._name, self._owner, str(doc_id), check_fields(patch))

    def remove(self, doc_id: str) -> bool:
        """Deletes a document.

        Args:
            doc_id: The document id.

        Returns:
            True when a document was deleted.
        """
        return self._rows.remove(self._name, self._owner, str(doc_id))


class _View:
    """What ``scope()`` and ``system()`` return: a way to open collections."""

    def __init__(self, rows: Any, owner: str | None):
        """Creates the view.

        Args:
            rows: The provider's row operations.
            owner: The owner everything is limited to, or None for every owner.
        """
        self._rows = rows
        self._owner = owner

    def collection(self, name: str) -> _Collection:
        """Opens a collection.

        Args:
            name: Lowercase letters, digits and underscores, starting with a letter.

        Returns:
            The collection.
        """
        return _Collection(self._rows, check_collection(name), self._owner)


class Views:
    """Gives a provider its ``scope()`` and ``system()`` from its row operations, so the checks are written once."""

    def __init__(self, rows: Any):
        """Wraps the row operations.

        Args:
            rows: An object with ``insert``, ``get``, ``list``, ``update`` and ``remove``, each taking
                ``(collection, owner_or_None, ...)``.
        """
        self._rows = rows

    def scope(self, owner_id: str) -> _View:
        """A view that only ever sees one owner's documents.

        Args:
            owner_id: The signed-in user's id.

        Returns:
            The view.

        Raises:
            ValueError: When the owner id is not a non-empty string.
        """
        if not isinstance(owner_id, str) or owner_id == "":
            raise ValueError("scope() needs the signed-in user's id.")
        return _View(self._rows, owner_id)

    def system(self) -> _View:
        """A view over every owner of the site, for event handlers.

        Returns:
            The view.
        """
        return _View(self._rows, None)


def same_type_equal(stored: Any, wanted: Any) -> bool:
    """Whether a stored field equals a filter value without Python's ``True == 1`` coercion.

    Args:
        stored: What the document holds.
        wanted: What the filter asks for.

    Returns:
        True when they are the same kind of value and equal.
    """
    if isinstance(stored, bool) or isinstance(wanted, bool):
        return isinstance(stored, bool) and isinstance(wanted, bool) and stored == wanted
    if isinstance(stored, (int, float)) and isinstance(wanted, (int, float)):
        return stored == wanted
    return type(stored) is type(wanted) and stored == wanted
