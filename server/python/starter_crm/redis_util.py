"""Shared Redis helpers: the address, its checks, key prefixes and a connected client.

Where it sits: the redis store, the redis and postgres fan-outs, the redis rate limiter
and the BullMQ webhook mode all read the address and build their keys here, so they
agree on both. The Node server has the same file (``src/redis.js``) and builds the
same key names, which is what lets a Node and a Python server share one Redis.

CONTRACT.md: "Event store" (Redis keys), "POST /webhooks/dropcowboy" (BullMQ).
What a customer changes: nothing.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from urllib.parse import urlparse

from .problems import BootProblem, problem
from .tls import allows_plaintext

LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")

# The BullMQ queue name every server uses, so a Node and a Python server share one queue.
QUEUE_NAME = "webhooks"


def site_key(config: Any) -> str:
    """The name events are filed under, so two apps sharing one store never see each other's.

    Args:
        config: The loaded config.

    Returns:
        ``DROPCOWBOY_SITE_ID``, or ``default`` for modes that do not need one.
    """
    return config.site_id or "default"


def redis_url(env: Mapping[str, str]) -> str | None:
    """Reads the Redis address.

    Args:
        env: The merged environment.

    Returns:
        ``DC_REDIS_URL``, else ``REDIS_URL``, else None.
    """
    for key in ("DC_REDIS_URL", "REDIS_URL"):
        value = env.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def validate_redis(env: Mapping[str, str], needs: str) -> list[BootProblem]:
    """Checks that a Redis address is present, well formed and, in production, TLS.

    Args:
        env: The merged environment.
        needs: What needs it, for the message, such as ``DC_STORE=redis``.

    Returns:
        Boot problems; empty when the address is fine.
    """
    raw = redis_url(env)
    if not raw:
        return [
            problem(
                "missing_redis_url",
                needs + " needs DC_REDIS_URL.",
                "Set DC_REDIS_URL to your Redis or Valkey address, for example rediss://default:password@host:6379.",
            )
        ]
    try:
        url = urlparse(raw)
        scheme = url.scheme
        host = url.hostname or ""
    except ValueError:
        return [
            problem(
                "invalid_redis_url",
                "DC_REDIS_URL is not a URL.",
                "Use an address such as redis://localhost:6379 or rediss://host:6379.",
            )
        ]
    if scheme not in ("redis", "rediss"):
        return [
            problem(
                "invalid_redis_url",
                "DC_REDIS_URL must start with redis:// or rediss://.",
                "Use an address such as redis://localhost:6379 or rediss://host:6379.",
            )
        ]
    cluster = str(env.get("DC_REDIS_CLUSTER") or "").strip().lower()
    if cluster not in ("", "on", "off", "1", "0", "true", "false"):
        return [
            problem(
                "invalid_redis_cluster",
                'DC_REDIS_CLUSTER must be on or off (got "' + str(env.get("DC_REDIS_CLUSTER")) + '").',
                "Set DC_REDIS_CLUSTER=on for a cluster-enabled Redis or Valkey such as ElastiCache Serverless, "
                "or leave it unset.",
            )
        ]
    if (
        env.get("DC_ENV") == "production"
        and scheme != "rediss"
        and host not in LOCAL_HOSTS
        and not allows_plaintext(env)
    ):
        return [
            problem(
                "insecure_redis_url",
                "DC_REDIS_URL must use TLS (rediss://) in production.",
                "Use rediss:// with your provider's TLS endpoint. Localhost is exempt, and so is a private network "
                "you control when DC_INSECURE_PRIVATE_SERVICES=on.",
            )
        ]
    return []


def key_prefix(config: Any) -> str:
    """The prefix for every key the redis store writes: one hash tag per site.

    Args:
        config: The loaded config.

    Returns:
        For example ``starter-crm:{3f8a2c1e-...}:``.
    """
    return "starter-crm:{" + site_key(config) + "}:"


def bullmq_prefix(config: Any) -> str:
    """The BullMQ prefix; the braces are a hash tag, so one site's queue lives on one cluster slot.

    Args:
        config: The loaded config.

    Returns:
        For example ``{starter-crm-3f8a2c1e-...}``; the Node server builds the same string.
    """
    return "{starter-crm-" + site_key(config) + "}"


def redis_cluster(env: Mapping[str, str]) -> bool:
    """Whether Redis runs in cluster mode (``DC_REDIS_CLUSTER=on``).

    ElastiCache Serverless and any cluster-enabled Valkey or Redis needs it: the client then treats ``DC_REDIS_URL``
    as one seed node, finds the rest, and follows MOVED redirects. Every key this starter writes carries one hash tag
    per site, so scripts that touch several keys keep working on a cluster.

    Args:
        env: The merged environment.

    Returns:
        True for ``on``, ``1`` or ``true``.
    """
    return str(env.get("DC_REDIS_CLUSTER") or "").strip().lower() in ("on", "1", "true")


def new_client(
    env: Mapping[str, str],
    connect_timeout: float = 5,
    socket_timeout: float | None = 10,
    health_check_interval: int | None = 30,
) -> Any:
    """Builds a Redis client for the configured address, a cluster client when ``DC_REDIS_CLUSTER`` is on.

    Args:
        env: The merged environment.
        connect_timeout: Seconds to wait for a connection.
        socket_timeout: Seconds to wait for an answer (None waits forever, which a long-lived subscriber needs).
        health_check_interval: Seconds between keep-alive pings on an idle connection (None for no check).

    Returns:
        A ``redis.Redis`` or ``redis.cluster.RedisCluster`` client (thread-safe; it keeps its own pool). It has not
        necessarily connected yet.
    """
    # The client is only needed when a Redis-backed provider is chosen, so it is not imported at module load.
    import redis

    options: dict[str, Any] = {
        "decode_responses": True,
        "socket_connect_timeout": connect_timeout,
        "socket_timeout": socket_timeout,
    }
    if health_check_interval:
        options["health_check_interval"] = health_check_interval
    url = redis_url(env) or ""
    if redis_cluster(env):
        from redis.cluster import RedisCluster

        return RedisCluster.from_url(url, **options)
    return redis.Redis.from_url(url, **options)


def connect_redis(env: Mapping[str, str]) -> Any:
    """Opens a Redis client and checks it can reach the server.

    Args:
        env: The merged environment (``DC_REDIS_URL``, ``DC_REDIS_CLUSTER``).

    Returns:
        A connected client.

    Raises:
        redis.exceptions.RedisError: When the server cannot be reached.
    """
    client = new_client(env)
    client.ping()
    return client
