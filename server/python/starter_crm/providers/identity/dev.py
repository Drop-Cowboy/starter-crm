"""The ``dev`` identity: everyone is the user in ``STARTER_CRM_USER_ID``.

Where it sits: the default while you build. It lets every request through as
one fixed user, which is only safe on your own machine, so ``DC_ENV=production``
refuses to start with it (``production_dev_identity``).

CONTRACT.md: "Boot" (``production_dev_identity``) and "Identity routes".
What a customer changes: nothing; switch ``DC_IDENTITY`` instead.
"""

from __future__ import annotations

from ...problems import BootProblem

name = "dev"
config_keys = ["STARTER_CRM_USER_ID"]

# Tells the provider conformance check that this identity signs everyone in on purpose.
always_signed_in = True


def validate(env) -> list[BootProblem]:
    """Nothing to check here: the config loader requires the user id.

    Args:
        env: The merged environment (unused).

    Returns:
        No problems.
    """
    return []


class DevIdentity:
    """Signs in the placeholder user on every request."""

    def __init__(self, user_id: str | None):
        """Creates the identity.

        Args:
            user_id: The value of ``STARTER_CRM_USER_ID``.
        """
        self._user_id = user_id

    def authenticate(self, request) -> dict:
        """Returns the placeholder user.

        Args:
            request: The Flask request (unused).

        Returns:
            ``{"id": STARTER_CRM_USER_ID}``.
        """
        return {"id": self._user_id}


def create(ctx) -> DevIdentity:
    """Creates the identity.

    Args:
        ctx: The provider context; ``ctx.config.starter_user_id`` is the user.

    Returns:
        The identity instance.
    """
    return DevIdentity(ctx.config.starter_user_id)
