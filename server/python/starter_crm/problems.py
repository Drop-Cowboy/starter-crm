"""Structured boot problems for the Starter CRM Python server.

Where it sits: ``load_config()`` builds these; ``__main__`` prints them and
exits before ``create_app()`` runs. Conformance suite ``08-boot`` matches on
``code`` and on variable names in ``message``.

CONTRACT.md: Configuration → Boot (structured problems).
Customers read the same codes in TROUBLESHOOTING.md.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class BootProblem:
    """One reason the server must not start.

    Attributes:
        code: Stable machine id (see CONTRACT.md / TROUBLESHOOTING.md).
        message: Plain-language description; names env vars, never secrets.
        fix: What to change to clear the problem.
        docs: Relative docs pointer, usually TROUBLESHOOTING.md#code.
    """

    code: str
    message: str
    fix: str
    docs: str


def problem(code: str, message: str, fix: str) -> BootProblem:
    """Builds one boot problem.

    Args:
        code: Stable machine id.
        message: Human-readable description.
        fix: Concrete next step.

    Returns:
        A BootProblem with docs pointing at TROUBLESHOOTING.md#code.
    """
    return BootProblem(code=code, message=message, fix=fix, docs="TROUBLESHOOTING.md#" + code)


def format_problems(problems: list[BootProblem]) -> str:
    """Formats problems for stderr.

    Args:
        problems: Boot problems from load_config.

    Returns:
        A multi-line string safe to print (no secrets).
    """
    lines: list[str] = []
    for item in problems:
        lines.append(item.code + ": " + item.message)
        lines.append("    fix: " + item.fix)
        lines.append("    docs: " + item.docs)
    return "\n".join(lines)
