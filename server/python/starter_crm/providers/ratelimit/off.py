"""The ``off`` rate limiter: counts nothing and allows everything.

Where it sits: ``DC_RATE_LIMIT=off``, for tests and for hosts that limit in
front of the server (a gateway or CDN).

CONTRACT.md: "Rate limits".
What a customer changes: nothing.
"""

from __future__ import annotations

from ...problems import BootProblem

name = "off"
config_keys: list[str] = []

# Tells the provider conformance check that this limiter allows everything on purpose.
never_limits = True


def validate(env) -> list[BootProblem]:
    """Nothing to configure.

    Args:
        env: The merged environment (unused).

    Returns:
        No problems.
    """
    return []


class OffLimiter:
    """A limiter that never refuses."""

    def hit(self, key: str, limit: int, window_seconds: int) -> dict:
        """Allows the request.

        Args:
            key: Ignored.
            limit: Ignored.
            window_seconds: Ignored.

        Returns:
            Always ``allowed``.
        """
        return {"allowed": True, "remaining": limit, "retry_after_seconds": 1}


def create(ctx=None) -> OffLimiter:
    """Creates the limiter.

    Args:
        ctx: The provider context (unused).

    Returns:
        The limiter instance.
    """
    return OffLimiter()
