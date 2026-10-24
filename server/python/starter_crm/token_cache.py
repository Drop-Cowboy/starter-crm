"""An in-memory cache of minted site tokens, one per user and purpose.

Where it sits: the token route asks the cache before calling Drop Cowboy, in
``server`` mode only. A page load asks for a token, a dialer asks again a minute
later, and tabs multiply that; without a cache every one of those is a mint
against your API key and a slot in the per-user limit.

Why a 60 second margin: a token with less than a minute left could expire
before the browser uses it, so it is treated as already gone. A cached token is
never shared across users (the key includes the user id), never logged, and
never written anywhere but this process's memory. With Gunicorn each worker
keeps its own cache.

CONTRACT.md: "Calling Drop Cowboy carefully".
Env: DC_TOKEN_CACHE (on by default).
What a customer changes: nothing.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

# A cached token must have more than this long left to be served again.
CACHE_MARGIN_MS = 60 * 1000

# The most entries kept; beyond it the oldest go, so a flood of distinct users cannot exhaust memory.
MAX_ENTRIES = 1000


class TokenCache:
    """Remembers tokens until they are about to expire. Thread-safe."""

    def __init__(self, now_ms: Callable[[], float] = lambda: time.time() * 1000):
        """Creates an empty cache.

        Args:
            now_ms: Clock in epoch milliseconds, replaceable in tests.
        """
        self._now_ms = now_ms
        self._entries: dict[str, dict] = {}
        self._lock = threading.Lock()

    def _usable(self, entry: dict) -> bool:
        return entry["expires_at"] - self._now_ms() > CACHE_MARGIN_MS

    def get(self, key: str) -> dict | None:
        """Looks up a token.

        Args:
            key: ``<user id>|<purpose>``.

        Returns:
            ``{"token", "expires_at"}`` while it has more than 60 seconds left, else None.
        """
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                return None
            if not self._usable(entry):
                del self._entries[key]
                return None
            return entry

    def set(self, key: str, entry: dict) -> None:
        """Stores a token, unless it is already inside the margin.

        Args:
            key: ``<user id>|<purpose>``.
            entry: ``{"token", "expires_at"}``.
        """
        with self._lock:
            if not self._usable(entry):
                return
            self._entries.pop(key, None)
            self._entries[key] = {"token": entry["token"], "expires_at": entry["expires_at"]}
            # A dict iterates in insertion order, so the first key is the oldest.
            while len(self._entries) > MAX_ENTRIES:
                del self._entries[next(iter(self._entries))]
