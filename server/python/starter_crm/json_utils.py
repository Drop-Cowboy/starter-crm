"""JSON helpers that behave like JavaScript's ``JSON.parse`` and ``typeof``.

The Node server and this one must accept and reject exactly the same input,
and Python's ``json`` module is more lenient in two ways that matter here:
it accepts ``NaN`` and ``Infinity``, and it treats ``true`` as a number
because ``bool`` is a subclass of ``int``.
"""

from __future__ import annotations

import json
import math
from typing import Any


def parse_json(text: str) -> Any:
    """Parse ``text`` as JSON. Raises ``ValueError`` on anything invalid."""
    return json.loads(text, parse_constant=_reject_constant)


def parse_object(text: str) -> dict | None:
    """Parse ``text`` as a JSON object. Returns None for anything else."""
    try:
        value = parse_json(text)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def is_number(value: Any) -> bool:
    """True for a finite int or float. False for booleans."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(value)


def _reject_constant(name: str) -> None:
    raise ValueError("JSON does not allow " + name)
