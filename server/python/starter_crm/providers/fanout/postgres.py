"""The ``postgres`` fan-out: ``LISTEN``/``NOTIFY`` carries the id of each finished event.

Where it sits: ``DC_FANOUT=postgres``, the default for ``DC_STORE=postgres`` without Redis on a
long-running host. When an instance finishes an event it sends a ``NOTIFY`` with the event's id on one
channel per site; every instance holds a ``LISTEN`` connection, reads the event from the store and
delivers it to its open streams. Only an id travels, so contact data never goes through the channel.
The Node server uses the same channel name.

``LISTEN`` needs a direct, unpooled connection. A pooled URL (Neon's pooler, Netlify Database) accepts
the connection but never delivers a notification; on those hosts use ``DC_FANOUT=poll``.

CONTRACT.md: "Fan-out".
Env: DC_DATABASE_URL. What a customer changes: nothing.
"""

from __future__ import annotations

import hashlib
import threading
from collections.abc import Callable, Mapping
from typing import Any

from ...problems import BootProblem, problem
from ..store.common import public_event, site_key
from ..store.postgres import database_url
from .hub import Hub

name = "postgres"
config_keys = ["DC_DATABASE_URL", "DATABASE_URL", "NETLIFY_DB_URL"]

# How long to wait before reconnecting a dropped listener.
RECONNECT_SECONDS = 1.0


def validate(env: Mapping[str, str]) -> list[BootProblem]:
    """Checks the connection string is there; the store's own validation checks its shape.

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    if not database_url(env):
        return [
            problem(
                "missing_database_url",
                "DC_FANOUT=postgres needs DC_DATABASE_URL.",
                "Set DC_DATABASE_URL, or choose DC_FANOUT=poll.",
            )
        ]
    return []


def channel_name(config: Any) -> str:
    """The notification channel for one site: a Postgres identifier of at most 63 characters.

    Args:
        config: The loaded config.

    Returns:
        For example ``starter_crm_3f8a2c1e9b4d7a6c``; the Node server computes the same name.
    """
    return "starter_crm_" + hashlib.sha1(site_key(config).encode("utf-8")).hexdigest()[:16]  # noqa: S324 - a name, not security


class PostgresFanout:
    """A fan-out over Postgres ``LISTEN``/``NOTIFY``."""

    def __init__(self, store: Any, config: Any, env: Mapping[str, str]):
        """Prepares the fan-out; nothing connects until ``start()``.

        Args:
            store: The event store, where a heard id is read.
            config: The loaded config (the channel is per site).
            env: The merged environment, for the connection string.
        """
        self._store = store
        self._channel = channel_name(config)
        self._url = database_url(env)
        self._hub = Hub()
        self._publisher: Any = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._listening = False

    def start(self) -> None:
        """Connects the publisher, starts the listener thread and waits until it listens. Safe to call twice."""
        if self._publisher is not None:
            return
        import psycopg

        self._publisher = psycopg.connect(self._url, autocommit=True, connect_timeout=5)
        ready = threading.Event()
        self._thread = threading.Thread(
            target=self._listen, args=(ready,), name="starter-crm-fanout-postgres", daemon=True
        )
        self._thread.start()
        if not ready.wait(10):
            raise RuntimeError("the postgres fan-out could not start listening")

    def _listen(self, ready: threading.Event) -> None:
        """Holds a ``LISTEN`` connection, delivering notified events until closed; reconnects when it drops.

        Args:
            ready: Set once the first ``LISTEN`` is in place.
        """
        import psycopg

        while not self._stop.is_set():
            try:
                with psycopg.connect(self._url, autocommit=True, connect_timeout=5) as conn:
                    conn.execute("LISTEN " + self._channel)
                    self._listening = True
                    ready.set()
                    # notifies() ends when its timeout passes with no message, so keep calling it until closed.
                    while not self._stop.is_set():
                        for notice in conn.notifies(timeout=1.0):
                            row = self._store.get(notice.payload)
                            if row:
                                self._hub.deliver(public_event(row))
            except Exception:  # noqa: BLE001 - a dropped connection; reconnect after a pause
                self._listening = False
                if self._stop.wait(RECONNECT_SECONDS):
                    return

    def publish(self, event: dict) -> None:
        """Announces a finished event to every instance.

        Args:
            event: The public event; only its id is sent.
        """
        self._publisher.execute("SELECT pg_notify(%s, %s)", (self._channel, event["event_id"]))

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
        """Whether the listener is connected.

        Returns:
            False when not started or reconnecting.
        """
        return self._listening

    def close(self) -> None:
        """Stops the listener and closes the publisher."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)
            self._thread = None
        if self._publisher is not None:
            self._publisher.close()
            self._publisher = None


def create(ctx: Any) -> PostgresFanout:
    """Creates the fan-out.

    Args:
        ctx: The provider context (``store``, ``config``, ``env``).

    Returns:
        The fan-out instance.
    """
    return PostgresFanout(ctx.store, ctx.config, ctx.env)
