"""Reads a JSON request body the way Express's ``express.json()`` does.

Where it sits: the token route and the passcode sign-in both read small JSON
bodies, and the Node server and this one must accept and reject exactly the
same input.

CONTRACT.md: "Error envelope" (``invalid_json``).
What a customer changes: nothing.
"""

from __future__ import annotations

from typing import Any

from flask import request

from .errors import HttpError
from .json_utils import parse_json

# The whitespace JSON allows around a value.
JSON_WHITESPACE = " \t\n\r"


def read_json_body() -> Any:
    """The request body, parsed the way ``express.json()`` does.

    Only ``application/json`` bodies are read, an empty body counts as ``{}``,
    and only an object or an array is accepted at the top level.

    Returns:
        The parsed value, ``{}`` for an empty body, or None when the body is not JSON-typed.

    Raises:
        HttpError: 400 ``invalid_json`` for a body that is not valid JSON.
    """
    if request.mimetype != "application/json":
        return None
    text = request.get_data().decode("utf-8", errors="replace")
    stripped = text.strip(JSON_WHITESPACE)
    if stripped == "":
        return {}
    if stripped[0] not in "{[":
        raise HttpError(400, "invalid_json", "Request body is not valid JSON.")
    try:
        return parse_json(text)
    except ValueError:
        raise HttpError(400, "invalid_json", "Request body is not valid JSON.") from None
