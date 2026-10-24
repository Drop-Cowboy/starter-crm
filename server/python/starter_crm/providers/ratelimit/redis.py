"""The ``redis`` rate limiter: one-minute windows counted in Redis, so limits hold across every instance.

Where it sits: ``DC_RATE_LIMIT=redis``, the default whenever ``DC_REDIS_URL`` is set. The same fixed-window
rule as the memory limiter, kept atomic by one Lua script: ``INCR`` the counter, and on the first hit of a
window ``PEXPIRE`` it. Redis, not the instance, decides who is over the limit, which is what makes it work
on hosts where every request may land on a different instance.

If Redis cannot be reached the limiter lets the request through and logs a warning, rather than turning a
Redis outage into an outage of sign-in and the dialer's tokens. That is a deliberate trade-off: the
passcode and token limits protect against abuse, not against data loss. The client connects on its first
use, so creating the limiter is safe before Gunicorn forks.

CONTRACT.md: "Rate limits".
Env: DC_REDIS_URL. What a customer changes: nothing.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any

from ...problems import BootProblem
from ...redis_util import key_prefix, new_client, validate_redis

name = "redis"
config_keys = ["DC_REDIS_URL", "REDIS_URL", "DC_REDIS_CLUSTER"]

_HIT = """
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return {count, ttl}
"""


def validate(env: Mapping[str, str]) -> list[BootProblem]:
    """Checks the Redis address.

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    return validate_redis(env, "DC_RATE_LIMIT=redis")


class RedisLimiter:
    """Counts hits per key in Redis."""

    def __init__(self, config: Any, env: Mapping[str, str], log: Any, client: Any = None):
        """Creates the limiter without connecting.

        Args:
            config: The loaded config (the key prefix is per site).
            env: The merged environment, for the Redis address.
            log: The redacting logger, for the unreachable warning.
            client: A ready ``redis.Redis`` client (tests); otherwise one is made from the address.
        """
        self._prefix = key_prefix(config) + "rl:"
        self._log = log
        if client is None:
            client = new_client(env, connect_timeout=2, socket_timeout=2, health_check_interval=None)
        self._client = client

    def hit(self, key: str, limit: int, window_seconds: int) -> dict:
        """Counts one hit.

        Args:
            key: Who the hit is counted for, such as ``token-ip:203.0.113.7``.
            limit: Hits allowed per window.
            window_seconds: Length of the window.

        Returns:
            ``{"allowed", "remaining", "retry_after_seconds"}``; allowed when Redis cannot be reached.
        """
        try:
            count, ttl = self._client.eval(_HIT, 1, self._prefix + key, str(window_seconds * 1000))
        except Exception as err:  # noqa: BLE001 - any client error: let the request through
            self._log.warn("The Redis rate limiter is unreachable, so this request was not counted:", str(err))
            return {"allowed": True, "remaining": limit, "retry_after_seconds": 1}
        return {
            "allowed": count <= limit,
            "remaining": max(0, limit - count),
            "retry_after_seconds": max(1, math.ceil(ttl / 1000)),
        }

    def close(self) -> None:
        """Closes the connection pool."""
        self._client.close()


def create(ctx: Any, client: Any = None) -> RedisLimiter:
    """Creates the limiter.

    Args:
        ctx: The provider context (``config``, ``env``, ``log``).
        client: A ready client, for tests.

    Returns:
        The limiter instance.
    """
    return RedisLimiter(ctx.config, ctx.env, ctx.log, client)
