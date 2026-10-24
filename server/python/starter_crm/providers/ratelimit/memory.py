"""The ``memory`` rate limiter: fixed one-minute windows counted in this process.

Where it sits: the app asks ``hit()`` before the token route, the passcode
sign-in and the dev session. Counts are per process, which is right for one or
two long-running instances (with Gunicorn, per worker). On serverless hosts
every instance counts alone, so limits barely bite; the shared ``redis`` limiter
(a later phase) is for those. A fixed window is deliberately simple and matches
what the Redis limiter will do.

CONTRACT.md: "Rate limits".
What a customer changes: nothing; to share counts across instances, set
``DC_RATE_LIMIT`` to a provider that does.
"""

from __future__ import annotations

import math
import threading
import time
from collections.abc import Callable

from ...problems import BootProblem

name = "memory"
config_keys: list[str] = []

# Past this many keys, expired windows are swept on the next hit, so a flood of
# distinct keys cannot grow memory without bound.
SWEEP_AT = 10000

# The hard cap: beyond it the oldest windows are dropped, accepting a briefly
# reset counter over an out-of-memory crash.
MAX_KEYS = 100000


def validate(env) -> list[BootProblem]:
    """Nothing to configure.

    Args:
        env: The merged environment (unused).

    Returns:
        No problems.
    """
    return []


class MemoryLimiter:
    """Counts hits per key in fixed windows. Thread-safe: requests run on several threads."""

    def __init__(self, now: Callable[[], float] = time.time):
        """Creates an empty limiter.

        Args:
            now: Clock in seconds since the epoch, replaceable in tests.
        """
        self._now = now
        self._windows: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def hit(self, key: str, limit: int, window_seconds: int) -> dict:
        """Counts one hit.

        Args:
            key: Who the hit is counted for, such as ``token-ip:203.0.113.7``.
            limit: Hits allowed per window.
            window_seconds: Length of the window.

        Returns:
            ``{"allowed", "remaining", "retry_after_seconds"}``.
        """
        with self._lock:
            at = self._now()
            if len(self._windows) >= SWEEP_AT:
                self._sweep(at)
            entry = self._windows.get(key)
            if entry is None or entry[1] <= at:
                entry = [0, at + window_seconds]
                self._windows[key] = entry
            entry[0] += 1
            return {
                "allowed": entry[0] <= limit,
                "remaining": max(0, limit - int(entry[0])),
                "retry_after_seconds": max(1, math.ceil(entry[1] - at)),
            }

    def _sweep(self, at: float) -> None:
        for key in [key for key, entry in self._windows.items() if entry[1] <= at]:
            del self._windows[key]
        # A dict iterates in insertion order, so the first keys are the oldest.
        while len(self._windows) > MAX_KEYS:
            del self._windows[next(iter(self._windows))]


def create(ctx=None, now: Callable[[], float] = time.time) -> MemoryLimiter:
    """Creates a limiter.

    Args:
        ctx: The provider context (unused).
        now: Clock, replaceable in tests.

    Returns:
        The limiter instance.
    """
    return MemoryLimiter(now)
