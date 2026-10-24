"""The ``console`` log provider: pretty lines or JSON lines on stdout and stderr.

Where it sits: the default ``DC_LOG``. The logger redacts every record first,
so this only has to print what it is given.

CONTRACT.md: "Logging".
What a customer changes: nothing; write a log provider to send records elsewhere.
"""

from __future__ import annotations

from ...log import ConsoleSink
from ...problems import BootProblem

name = "console"
config_keys: list[str] = []


def validate(env) -> list[BootProblem]:
    """Nothing to configure here: ``DC_LOG_FORMAT`` is checked by the config loader.

    Args:
        env: The merged environment (unused).

    Returns:
        No problems.
    """
    return []


def create(ctx) -> ConsoleSink:
    """Creates the sink.

    Args:
        ctx: The provider context; ``ctx.config.log_format`` picks pretty or JSON.

    Returns:
        The sink.
    """
    return ConsoleSink(ctx.config.log_format)
