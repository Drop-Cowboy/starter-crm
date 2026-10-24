"""A small JSON Schema checker for request bodies.

Where it sits: a module route names a schema (``router.post("/", handler, body=schemas["create"])``) and
``module_runtime`` calls ``check_body()`` before the handler runs, so a handler only ever sees input that already
fits. The schemas are plain JSON files in ``server/schemas/``, shared with the Node server (``src/validate.js``),
and a conformance vector file (``server/conformance/provider/schema-vectors.json``) keeps the two checkers saying
the same thing in the same words.

Only the keywords a request body needs are supported: ``type`` (one name or a list), ``properties``, ``required``,
``additionalProperties`` (false only), ``enum``, ``minLength``, ``maxLength``, ``minimum``, ``maximum``,
``pattern``, ``format`` (``uuid`` only), ``items``, ``maxItems`` and ``minProperties``. A ``pattern`` must match the
whole string (the checker anchors it) and should stick to plain character classes such as ``[A-Z]{3}``, which mean
the same in JavaScript and Python. Anything else is a mistake in the schema and raises when the schema is loaded,
not when a user posts.

The first problem found is reported, as ``<field>: <what is wrong>``, so a form can show it next to the right
input. A field inside an object is ``parent.child``; inside a list, ``parent[0]``.

CONTRACT.md: "Modules" (Input validation).
What a customer changes: nothing; write a schema file and name it in your route.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .errors import HttpError

# The keywords this checker understands; any other is rejected so a typo cannot silently allow bad input.
KEYWORDS = frozenset(
    {
        "type",
        "properties",
        "required",
        "additionalProperties",
        "enum",
        "minLength",
        "maxLength",
        "minimum",
        "maximum",
        "pattern",
        "format",
        "items",
        "maxItems",
        "minProperties",
        "description",
        "$comment",
    }
)

# The type names a schema may use.
TYPES = frozenset({"object", "string", "integer", "number", "boolean", "array", "null"})

# How each type is written in a message: "must be a string", "must be an integer".
TYPE_PHRASES = {
    "object": "an object",
    "string": "a string",
    "integer": "an integer",
    "number": "a number",
    "boolean": "a boolean",
    "array": "an array",
    "null": "null",
}

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)

# Where the schema files live: ``server/schemas``, two folders above this package.
SCHEMAS_DIR = Path(__file__).resolve().parents[2] / "schemas"


def load_schemas(name: str) -> dict[str, dict]:
    """Reads a schema file and checks it only uses supported keywords.

    Args:
        name: The file name without ``.json``, such as ``deals``.

    Returns:
        The file's schemas by name (for Deals: ``create``, ``update`` and ``query``).

    Raises:
        OSError: When the file is missing.
        ValueError: When it is not JSON, or uses a keyword this checker does not support.
    """
    parsed = json.loads((SCHEMAS_DIR / (name + ".json")).read_text(encoding="utf-8"))
    schemas = {}
    for key, value in parsed.items():
        if key.startswith("$"):
            continue
        assert_supported(value, name + "." + key)
        schemas[key] = value
    return schemas


def assert_supported(schema: Any, where: str) -> None:
    """Walks a schema and raises on any keyword the checker does not implement.

    Args:
        schema: The schema to check.
        where: Where it is, for the error message.

    Raises:
        ValueError: Naming the unsupported keyword and where it is.
    """
    if not isinstance(schema, dict):
        raise ValueError("schema " + where + " must be an object")
    for key in schema:
        if key not in KEYWORDS:
            raise ValueError("schema " + where + ' uses "' + key + '", which this checker does not support')
    declared = schema.get("type")
    for kind in [] if declared is None else (declared if isinstance(declared, list) else [declared]):
        if kind not in TYPES:
            raise ValueError("schema " + where + ' has an unknown type "' + str(kind) + '"')
    if "additionalProperties" in schema and schema["additionalProperties"] is not False:
        raise ValueError("schema " + where + ": additionalProperties may only be false")
    if "format" in schema and schema["format"] != "uuid":
        raise ValueError("schema " + where + ' has an unsupported format "' + str(schema["format"]) + '"')
    for key, child in (schema.get("properties") or {}).items():
        assert_supported(child, where + "." + key)
    if "items" in schema:
        assert_supported(schema["items"], where + "[]")


def _types_of(value: Any) -> list[str]:
    """The JSON type names a value has: an integer is also a number.

    Python's ``bool`` is a kind of ``int`` and ``5.0`` is a float, but JSON parsed by JavaScript calls ``5.0`` an
    integer, so a float with no fraction counts as one here too.

    Args:
        value: Anything parsed from JSON.

    Returns:
        Every type name that fits.
    """
    if value is None:
        return ["null"]
    if isinstance(value, bool):
        return ["boolean"]
    if isinstance(value, int):
        return ["integer", "number"]
    if isinstance(value, float):
        return ["integer", "number"] if value.is_integer() else ["number"]
    if isinstance(value, list):
        return ["array"]
    if isinstance(value, dict):
        return ["object"]
    return ["string"]


def first_problem(schema: dict, value: Any, at: str = "") -> str | None:
    """Finds the first thing wrong with a value, or None when it fits the schema.

    Args:
        schema: A schema from ``load_schemas()``.
        value: The parsed request body.
        at: The field name so far; empty for the body itself.

    Returns:
        A message such as ``title: must be at least 1 character``, or None.
    """
    label = "body" if at == "" else at
    if "type" in schema:
        wanted = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        have = _types_of(value)
        if not any(kind in have for kind in wanted):
            return label + ": must be " + " or ".join(TYPE_PHRASES[kind] for kind in wanted)
    if "enum" in schema and not any(_same_enum(value, option) for option in schema["enum"]):
        return label + ": must be one of " + ", ".join(str(option) for option in schema["enum"])
    if isinstance(value, str):
        found = _string_problem(schema, value, label)
        if found:
            return found
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            return label + ": must be at least " + str(schema["minimum"])
        if "maximum" in schema and value > schema["maximum"]:
            return label + ": must be at most " + str(schema["maximum"])
    if isinstance(value, list):
        return _array_problem(schema, value, label)
    if isinstance(value, dict):
        return _object_problem(schema, value, at)
    return None


def _same_enum(value: Any, option: Any) -> bool:
    """Whether a value is one of the allowed options, without Python's ``True == 1`` coercion.

    Args:
        value: The value being checked.
        option: One allowed value from the schema.

    Returns:
        True when they are the same kind of value and equal.
    """
    return type(value) is type(option) and value == option


def _string_problem(schema: dict, value: str, label: str) -> str | None:
    """Checks a string against ``minLength``, ``maxLength``, ``format`` and ``pattern``.

    Args:
        schema: The schema for the string.
        value: The string.
        label: The field name, for messages.

    Returns:
        The first problem, or None.
    """
    # Length is counted in characters (code points), the same way the Node server counts.
    length = len(value)
    if "minLength" in schema and length < schema["minLength"]:
        least = schema["minLength"]
        return label + ": must be at least " + str(least) + (" character" if least == 1 else " characters")
    if "maxLength" in schema and length > schema["maxLength"]:
        most = schema["maxLength"]
        return label + ": must be at most " + str(most) + (" character" if most == 1 else " characters")
    if schema.get("format") == "uuid" and _UUID.fullmatch(value) is None:
        return label + ": must be a UUID"
    if "pattern" in schema and re.fullmatch(schema["pattern"], value) is None:
        return label + ": has the wrong format"
    return None


def _array_problem(schema: dict, value: list, label: str) -> str | None:
    """Checks a list against ``maxItems`` and ``items``.

    Args:
        schema: The schema for the list.
        value: The list.
        label: The field name, for messages.

    Returns:
        The first problem, or None.
    """
    if "maxItems" in schema and len(value) > schema["maxItems"]:
        most = schema["maxItems"]
        return label + ": must have at most " + str(most) + (" item" if most == 1 else " items")
    if "items" not in schema:
        return None
    for index, item in enumerate(value):
        found = first_problem(schema["items"], item, label + "[" + str(index) + "]")
        if found:
            return found
    return None


def _object_problem(schema: dict, value: dict, at: str) -> str | None:
    """Checks an object against ``required``, ``minProperties``, ``properties`` and ``additionalProperties``.

    Args:
        schema: The schema for the object.
        value: The object.
        at: The field name so far; empty for the body itself.

    Returns:
        The first problem, or None.
    """

    def join(key: str) -> str:
        return key if at == "" else at + "." + key

    label = "body" if at == "" else at
    properties = schema.get("properties") or {}
    for key in schema.get("required") or []:
        if key not in value:
            return join(key) + ": is required"
    if "minProperties" in schema and len(value) < schema["minProperties"]:
        least = schema["minProperties"]
        return label + ": must have at least " + str(least) + (" field" if least == 1 else " fields")
    # Declaration order first, so the message does not depend on the order the caller sent the keys.
    for key, child in properties.items():
        if key in value:
            found = first_problem(child, value[key], join(key))
            if found:
                return found
    if schema.get("additionalProperties") is False:
        extra = sorted(key for key in value if key not in properties)
        if extra:
            return join(extra[0]) + ": is not allowed"
    return None


def check_body(schema: dict, body: Any) -> None:
    """Raises 400 ``invalid_request`` when a request body does not fit its schema.

    Args:
        schema: A schema from ``load_schemas()``.
        body: The parsed JSON body.

    Raises:
        HttpError: 400 ``invalid_request``, with the field and the problem in the message.
    """
    found = first_problem(schema, body)
    if found:
        raise HttpError(400, "invalid_request", found + ".")
