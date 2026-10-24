"""The ``1password`` secrets provider: reads fields of one 1Password item, or one item per secret.

Where it sits: ``DC_SECRETS=1password``. The provider signs in with a service
account token (``OP_SERVICE_ACCOUNT_TOKEN``) through the official SDK and
resolves secret references for the names the starter asks for:

- With ``OP_ITEM`` set, one item holds a field per secret and the reference is
  ``op://<vault>/<item>/<NAME>``. Create a field called ``DROPCOWBOY_API_KEY``
  and so on in that item.
- Without ``OP_ITEM``, each secret is its own item, named like the variable, and
  the value is read from its ``credential`` field: ``op://<vault>/<NAME>/credential``.

A name with no matching field is simply left out, like any provider. If none of
the names can be read at all, the provider fails, since that points at a wrong
vault, item or token and not at an optional secret.

The SDK is ``onepassword-sdk``, pinned in requirements.txt and imported only here,
only when this provider is selected, so the other providers never load it. Its
client is asynchronous; each read runs it to completion in its own event loop, so
the rest of the server stays synchronous. The token is the bootstrap credential
and comes from the host's environment.

CONTRACT.md: "Providers" (secrets).
Env: OP_SERVICE_ACCOUNT_TOKEN and OP_VAULT (required), OP_ITEM (optional).
What a customer changes: nothing.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable
from typing import Any

from ...problems import BootProblem, problem

name = "1password"
config_keys = ["OP_SERVICE_ACCOUNT_TOKEN", "OP_VAULT", "OP_ITEM"]

INTEGRATION_NAME = "Drop Cowboy Starter CRM"
INTEGRATION_VERSION = "1.0.0"
# A slash or a query character would change which reference is resolved.
_UNSAFE = re.compile(r"[/?#]")


def validate(env) -> list[BootProblem]:
    """Checks the token and the vault are set, and that the names are usable in a reference.

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    problems: list[BootProblem] = []

    def is_set(key: str) -> bool:
        return bool((env.get(key) or "").strip())

    if not is_set("OP_SERVICE_ACCOUNT_TOKEN"):
        problems.append(
            problem(
                "missing_onepassword_setting",
                "DC_SECRETS=1password needs OP_SERVICE_ACCOUNT_TOKEN.",
                "Create a service account with read access to one vault and set OP_SERVICE_ACCOUNT_TOKEN"
                " to its token in the host's environment.",
            )
        )
    if not is_set("OP_VAULT"):
        problems.append(
            problem(
                "missing_onepassword_setting",
                "DC_SECRETS=1password needs OP_VAULT.",
                "Set OP_VAULT to the name or id of the vault that holds the secrets.",
            )
        )
    for key in ("OP_VAULT", "OP_ITEM"):
        if is_set(key) and _UNSAFE.search(env[key]):
            problems.append(
                problem(
                    "invalid_onepassword_setting",
                    key + " must not contain /, ? or #.",
                    "Use the plain name or id of the " + ("vault" if key == "OP_VAULT" else "item") + ".",
                )
            )
    return problems


def _real_client_factory(token: str) -> Callable[[], Awaitable[Any]]:
    """Builds the factory that signs in with the real SDK.

    Args:
        token: The service account token.

    Returns:
        A function that returns an awaitable signed-in client.
    """

    async def factory():
        # Imported here, not at the top: the SDK (a native library) loads only when DC_SECRETS=1password.
        from onepassword.client import Client

        return await Client.authenticate(
            auth=token, integration_name=INTEGRATION_NAME, integration_version=INTEGRATION_VERSION
        )

    return factory


class OnePasswordSecrets:
    """Resolves secret references for the names it is asked for."""

    def __init__(self, env, client_factory: Callable[[], Awaitable[Any]] | None = None):
        """Creates the provider.

        Args:
            env: The merged environment holding the OP_* settings.
            client_factory: Returns an awaitable signed-in client; replaced in tests so no network or SDK is needed.
        """
        self._vault = env["OP_VAULT"].strip()
        self._item = (env.get("OP_ITEM") or "").strip()
        self._factory = client_factory or _real_client_factory(env["OP_SERVICE_ACCOUNT_TOKEN"].strip())
        self._last_names: list[str] = []

    def load(self, names: list[str]) -> dict:
        """Resolves the named secrets.

        Args:
            names: The secret names to look for.

        Returns:
            ``{NAME: value}`` for each name that resolves to text.
        """
        self._last_names = list(names)
        return self._read(self._last_names)

    def refresh(self) -> dict:
        """Resolves again the names the last ``load`` asked for.

        Returns:
            ``{NAME: value}`` as of now.
        """
        return self._read(self._last_names)

    def _reference(self, secret_name: str) -> str:
        if self._item:
            return "op://" + self._vault + "/" + self._item + "/" + secret_name
        return "op://" + self._vault + "/" + secret_name + "/credential"

    async def _resolve_all(self, names: list[str]) -> tuple[dict, Exception | None]:
        client = await self._factory()

        async def one(secret_name: str):
            try:
                return secret_name, await client.secrets.resolve(self._reference(secret_name)), None
            except Exception as err:  # noqa: BLE001 - the SDK raises its own error types; a missing field is expected
                return secret_name, None, err

        results = await asyncio.gather(*(one(secret_name) for secret_name in names))
        values = {key: value for key, value, _ in results if isinstance(value, str) and value != ""}
        failed = next((err for _, _, err in results if err is not None), None)
        return values, failed

    def _read(self, names: list[str]) -> dict:
        values, failed = asyncio.run(self._resolve_all(names))
        if names and not values and failed is not None:
            raise RuntimeError(
                '1Password could not read any secret from vault "'
                + self._vault
                + '"'
                + (', item "' + self._item + '"' if self._item else "")
                + ": "
                + (str(failed) or failed.__class__.__name__)
            )
        return values


def create(ctx) -> OnePasswordSecrets:
    """Creates the provider.

    Args:
        ctx: The provider context; ``ctx.env`` holds the OP_* settings.

    Returns:
        The instance.
    """
    return OnePasswordSecrets(ctx.env)
