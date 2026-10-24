"""The one exception to "Redis and Postgres must use TLS in production".

Where it sits: ``redis_util`` and the postgres store check the address of their service, and refuse a plain
connection to a remote host when ``DC_ENV=production``. That is right for a managed service across the
internet. It is wrong for a Redis container on the private network of your own Compose project, so an
operator can say, once, that the services are on a network they control: ``DC_INSECURE_PRIVATE_SERVICES=on``.
It applies to both services and is off by default. Node has the same check (``src/tls.js``).

CONTRACT.md: "Event store" (Production).
What a customer changes: nothing; set the variable only where it is true.
"""

from __future__ import annotations

from collections.abc import Mapping


def allows_plaintext(env: Mapping[str, str]) -> bool:
    """Whether the operator says Redis and Postgres sit on a private network they control, so plain is fine.

    Args:
        env: The merged environment.

    Returns:
        True for ``DC_INSECURE_PRIVATE_SERVICES`` set to ``on``, ``1`` or ``true``.
    """
    return str(env.get("DC_INSECURE_PRIVATE_SERVICES") or "").strip().lower() in ("on", "1", "true")
