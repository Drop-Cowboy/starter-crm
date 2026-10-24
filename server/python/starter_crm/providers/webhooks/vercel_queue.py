"""The ``vercel-queue`` webhook mode is not available in the Python server.

Where it sits: ``DC_WEBHOOKS=vercel-queue`` is the default on Vercel, where the Starter CRM runs as its Next.js variant
(``server/nextjs``, Node). Vercel Queues delivers messages to a route of that Next.js app, and the Python server has
no Vercel host to receive them, so it names the choices that do work instead of starting without a queue.

CONTRACT.md: "POST /webhooks/dropcowboy" (Processing).
What a customer changes: nothing; choose another mode.
"""

from __future__ import annotations

from typing import Any

from ...problems import BootProblem, problem

name = "vercel-queue"
config_keys: list[str] = []


def validate(env: Any) -> list[BootProblem]:
    """Always refuses, naming the modes the Python server has.

    Args:
        env: The merged environment (unused).

    Returns:
        One boot problem.
    """
    return [
        problem(
            "vercel_queue_node_only",
            "DC_WEBHOOKS=vercel-queue is only available in the Node server (the Next.js variant on Vercel).",
            "Set DC_WEBHOOKS to qstash (Upstash, any host with a public address), bullmq (Redis), sqs (AWS), "
            "store (one machine) or inline.",
        )
    ]


def create(ctx: Any) -> Any:
    """Never reached: ``validate`` stops the boot first.

    Args:
        ctx: The provider context (unused).

    Raises:
        RuntimeError: Always.
    """
    raise RuntimeError("DC_WEBHOOKS=vercel-queue is only available in the Node server.")
