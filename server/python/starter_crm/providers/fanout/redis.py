"""The ``redis`` fan-out: Redis pub/sub carries the id of each finished event.

Where it sits: ``DC_FANOUT=redis``, the default whenever ``DC_REDIS_URL`` is set, and it works on
every host (Valkey in Compose, ElastiCache, Upstash). When an instance finishes an event it publishes
the event's id on one channel per site; every instance, including that one, hears it, reads the event
from the store and delivers it to its open streams. Only an id travels through Redis, so contact data
never sits in pub/sub. The Node server uses the same channel name.

Pub/sub drops messages while a subscriber is disconnected. That is acceptable here because a browser
that missed a push replays from the store when it reconnects; the thread resubscribes on its own.

CONTRACT.md: "Fan-out".
Env: DC_REDIS_URL. What a customer changes: nothing.
"""

from __future__ import annotations

import contextlib
import threading
from collections.abc import Callable, Mapping
from typing import Any

from ...problems import BootProblem
from ...redis_util import key_prefix, new_client, validate_redis
from ..store.common import public_event
from .hub import Hub

name = "redis"
config_keys = ["DC_REDIS_URL", "REDIS_URL", "DC_REDIS_CLUSTER"]

# How long to wait before resubscribing after the connection drops.
RECONNECT_SECONDS = 1.0


def validate(env: Mapping[str, str]) -> list[BootProblem]:
    """Checks the Redis address.

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    return validate_redis(env, "DC_FANOUT=redis")


class RedisFanout:
    """A fan-out over Redis pub/sub, with a listener thread."""

    def __init__(self, store: Any, config: Any, env: Mapping[str, str]):
        """Prepares the fan-out; nothing connects until ``start()``.

        Args:
            store: The event store, where a heard id is read.
            config: The loaded config (the channel is per site).
            env: The merged environment, for the Redis address.
        """
        self._store = store
        self._channel = key_prefix(config) + "fanout"
        self._env = env
        self._hub = Hub()
        self._client: Any = None
        self._pubsub: Any = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._listening = False

    def start(self) -> None:
        """Connects, subscribes and starts the listener thread. Safe to call twice."""
        if self._client is not None:
            return
        self._client = new_client(self._env, socket_timeout=None)
        self._client.ping()
        self._subscribe()
        self._thread = threading.Thread(target=self._listen, name="starter-crm-fanout-redis", daemon=True)
        self._thread.start()

    def _subscribe(self) -> None:
        """Opens a fresh pub/sub connection on the site's channel."""
        self._pubsub = self._client.pubsub(ignore_subscribe_messages=True)
        self._pubsub.subscribe(self._channel)
        self._listening = True

    def _listen(self) -> None:
        """Reads published ids until closed, resubscribing when the connection drops."""
        while not self._stop.is_set():
            try:
                message = self._pubsub.get_message(timeout=1.0)
                if message and message.get("type") == "message":
                    row = self._store.get(message["data"])
                    if row:
                        self._hub.deliver(public_event(row))
            except Exception:  # noqa: BLE001 - a dropped connection or a store blip; resubscribe and carry on
                self._listening = False
                if self._stop.wait(RECONNECT_SECONDS):
                    return
                # Still down: the loop tries again.
                with contextlib.suppress(Exception):
                    self._subscribe()

    def publish(self, event: dict) -> None:
        """Announces a finished event to every instance.

        Args:
            event: The public event; only its id is sent.
        """
        self._client.publish(self._channel, event["event_id"])

    def subscribe(self, handler: Callable[[dict], None], after_event_id: str | None = None) -> Callable[[], None]:
        """Adds a subscriber.

        Args:
            handler: Called with each event any instance finishes from now on.
            after_event_id: Unused; the stream replays from the store itself.

        Returns:
            A function that removes the subscriber.
        """
        return self._hub.subscribe(handler)

    def ready(self) -> bool:
        """Whether Redis answers and the listener is subscribed.

        Returns:
            False when not started, disconnected or resubscribing.
        """
        try:
            return bool(self._client is not None and self._client.ping() and self._listening)
        except Exception:  # noqa: BLE001 - any client error means not ready
            return False

    def close(self) -> None:
        """Stops the listener and closes the connections."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)
            self._thread = None
        if self._pubsub is not None:
            self._pubsub.close()
            self._pubsub = None
        if self._client is not None:
            self._client.close()
            self._client = None


def create(ctx: Any) -> RedisFanout:
    """Creates the fan-out.

    Args:
        ctx: The provider context (``store``, ``config``, ``env``).

    Returns:
        The fan-out instance.
    """
    return RedisFanout(ctx.store, ctx.config, ctx.env)
