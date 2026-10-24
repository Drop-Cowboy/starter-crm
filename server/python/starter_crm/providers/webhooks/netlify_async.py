"""The ``netlify-async`` webhook mode is not available in the Python server.

Where it sits: ``DC_WEBHOOKS=netlify-async`` is the default on Netlify, where the Starter CRM runs as its Netlify
variant (``server/netlify``, Node). Netlify Async Workloads runs events in a workload function written with Netlify's
JavaScript SDK, and Netlify does not run this Python server, so it names the choices that do work instead of starting
without a queue.

CONTRACT.md: "POST /webhooks/dropcowboy" (Processing).
What a customer changes: nothing; choose another mode.
"""

from __future__ import annotations

from typing import Any

from ...problems import BootProblem, problem

name = "netlify-async"
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
            "netlify_async_node_only",
            "DC_WEBHOOKS=netlify-async is only available in the Node server (the Netlify variant).",
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
    raise RuntimeError("DC_WEBHOOKS=netlify-async is only available in the Node server.")
