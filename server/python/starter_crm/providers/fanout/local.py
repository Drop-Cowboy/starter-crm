"""The ``local`` fan-out: events reach the browsers connected to this process.

Where it sits: ``DC_FANOUT=local``, the default for the memory and sqlite stores, where
one process serves every browser and finishes every event. With several instances use
``redis``, ``postgres`` or ``poll``, or a browser on instance B never sees an event that
instance A finished.

CONTRACT.md: "Fan-out".
What a customer changes: nothing.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from ...problems import BootProblem
from .hub import Hub

name = "local"
config_keys: list[str] = []


def validate(env: Any) -> list[BootProblem]:
    """Nothing to configure.

    Args:
        env: The merged environment (unused).

    Returns:
        No problems.
    """
    return []


class LocalFanout:
    """An in-process fan-out."""

    def __init__(self) -> None:
        """Creates the fan-out with an empty hub."""
        self._hub = Hub()

    def start(self) -> None:
        """Nothing to open."""

    def publish(self, event: dict) -> None:
        """Delivers an event to this process's subscribers.

        Args:
            event: The public event.
        """
        self._hub.deliver(event)

    def subscribe(self, handler: Callable[[dict], None], after_event_id: str | None = None) -> Callable[[], None]:
        """Adds a subscriber.

        Args:
            handler: Called with each event published from now on.
            after_event_id: Unused; the local fan-out never misses an event.

        Returns:
            A function that removes the subscriber.
        """
        return self._hub.subscribe(handler)

    def ready(self) -> bool:
        """A local fan-out is always ready.

        Returns:
            True.
        """
        return True

    def close(self) -> None:
        """Nothing to close."""


def create(ctx: Any = None) -> LocalFanout:
    """Creates the fan-out.

    Args:
        ctx: The provider context (unused).

    Returns:
        The fan-out instance.
    """
    return LocalFanout()
