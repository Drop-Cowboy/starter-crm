"""The ``env`` secrets provider: the environment (and ``.env``) is already the source.

Where it sits: the default ``DC_SECRETS``. It adds nothing, so secrets keep
coming from the process environment.

CONTRACT.md: "Providers" (secrets).
What a customer changes: nothing; choose ``file`` or write your own provider for a vault.
"""

from __future__ import annotations

from ...problems import BootProblem

name = "env"
config_keys: list[str] = []


def validate(env) -> list[BootProblem]:
    """Nothing to configure.

    Args:
        env: The merged environment (unused).

    Returns:
        No problems.
    """
    return []


class EnvSecrets:
    """Loads and refreshes nothing."""

    def load(self, names: list[str]) -> dict:
        """Returns no values: the environment is read as usual.

        Args:
            names: The secret names asked for (ignored).

        Returns:
            An empty dict.
        """
        return {}

    def refresh(self) -> dict:
        """Returns no values.

        Returns:
            An empty dict.
        """
        return {}


def create(ctx=None) -> EnvSecrets:
    """Creates the provider.

    Args:
        ctx: The provider context (unused).

    Returns:
        An instance that adds nothing.
    """
    return EnvSecrets()
