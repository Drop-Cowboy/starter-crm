"""The ``inline`` webhook mode: handlers run before the acknowledgement.

Where it sits: ``DC_WEBHOOKS=inline``. The webhook records the event, runs its handlers
right there, and answers 200 only when they finish. That is the simplest thing that works
and the right one when handlers are fast and the host cannot keep a worker alive. The
handlers are always waited for to completion (nothing is left dangling after the answer).
They receive a signal that is set after ``DC_WEBHOOK_HANDLER_BUDGET_MS`` (default 3000), so
a slow one can stop early; a handler that overruns is logged with a hint to use a queue mode.
If a handler fails the webhook answers 503, so Drop Cowboy retries the delivery.

CONTRACT.md: "POST /webhooks/dropcowboy" (Processing).
Env: DC_WEBHOOK_HANDLER_BUDGET_MS. What a customer changes: nothing.
"""

from __future__ import annotations

from typing import Any

from ...problems import BootProblem

name = "inline"
config_keys = ["DC_WEBHOOK_HANDLER_BUDGET_MS"]


def validate(env: Any) -> list[BootProblem]:
    """Nothing beyond the budget, which the config parser checks.

    Args:
        env: The merged environment (unused).

    Returns:
        No problems.
    """
    return []


class InlineDispatcher:
    """Runs the handlers inside the webhook request."""

    # How long a recorded event waits before the maintenance sweep may touch it, so it never races a live request.
    visible_delay_ms = 120000

    def __init__(self, config: Any, processor: Any):
        """Creates the dispatcher.

        Args:
            config: The loaded config (the handler budget).
            processor: The processor that runs handlers.
        """
        self._budget = config.events.handler_budget_ms
        self._processor = processor

    def dispatch(self, event_id: str) -> dict:
        """Runs the event's handlers now.

        Args:
            event_id: The recorded event.

        Returns:
            ``{"outcome": ..., "error": ...}`` from the processor.
        """
        result = self._processor.process(event_id, budget_ms=self._budget)
        return {"outcome": result["outcome"], "error": result.get("error")}

    def sweep(self, event_ids: list[str]) -> None:
        """Runs events a crash left unfinished.

        Args:
            event_ids: The stale events.
        """
        for event_id in event_ids:
            self._processor.process(event_id, budget_ms=self._budget)

    def start(self) -> None:
        """Nothing to start."""

    def stop(self) -> None:
        """Nothing to stop."""

    def ready(self) -> bool:
        """Inline handling is always ready.

        Returns:
            True.
        """
        return True


def create(ctx: Any) -> InlineDispatcher:
    """Creates the dispatcher.

    Args:
        ctx: The provider context (``config`` and ``processor``).

    Returns:
        The dispatcher instance.
    """
    return InlineDispatcher(ctx.config, ctx.processor)
