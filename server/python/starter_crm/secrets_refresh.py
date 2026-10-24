"""Applies secrets from a provider to the live config, and refreshes them.

Where it sits: ``bootstrap`` builds one runtime when the secrets provider can
``refresh()``. The app calls ``refresh_if_due()`` at the start of each request,
so a rotated API key or webhook secret is picked up without a restart.

Why lazily, on a request, instead of a timer: a background thread's work is not
tied to any request, and some hosts freeze the process between requests. Doing
the refresh inside a request behaves the same on every host. The cost is that
the first request after the interval waits for one provider call.

CONTRACT.md: "Providers" (secrets).
Env: DC_SECRETS_REFRESH_SECONDS.
What a customer changes: nothing.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Mapping
from typing import Any

from .config import Config


def apply_secrets(config: Config, values: Mapping[str, Any]) -> None:
    """Copies the secrets this server swaps at run time onto ``config``.

    ``DC_PASSCODE`` is read once at boot and is not swapped here.

    Args:
        config: The live config.
        values: Secret name to value.
    """
    api_key = values.get("DROPCOWBOY_API_KEY")
    if isinstance(api_key, str) and api_key.strip():
        config.api_key = api_key.strip()
    api_secret = values.get("DROPCOWBOY_API_SECRET")
    if isinstance(api_secret, str) and api_secret.strip():
        config.api_secret = api_secret.strip()
    webhook = values.get("DROPCOWBOY_WEBHOOK_SECRET")
    if isinstance(webhook, str):
        listed = [item.strip() for item in webhook.split(",") if item.strip()]
        if listed:
            config.webhook_secrets = listed
    for value in values.values():
        if isinstance(value, str) and value:
            config.known_secrets.add(value)


class SecretsRuntime:
    """Refreshes secrets once the interval has passed, inside a request."""

    def __init__(
        self,
        config: Config,
        instance: Any,
        log: Any,
        interval_seconds: int,
        now: Callable[[], float] = time.monotonic,
    ):
        """Creates the runtime.

        Args:
            config: The live config.
            instance: The secrets provider instance (needs ``refresh()``).
            log: The logger (needs ``warn``).
            interval_seconds: How often to refresh; 0 never.
            now: Clock in seconds, replaceable in tests.
        """
        self._config = config
        self._instance = instance
        self._log = log
        self._interval = interval_seconds
        self._now = now
        self._last = now()
        self._lock = threading.Lock()

    def refresh_if_due(self) -> None:
        """Calls the provider's ``refresh()`` when the interval has passed.

        Concurrent requests share one refresh: the first takes it, the rest carry on with the current values.
        """
        if self._interval <= 0:
            return
        if not self._lock.acquire(blocking=False):
            return
        try:
            if self._now() - self._last < self._interval:
                return
            self._last = self._now()
            try:
                apply_secrets(self._config, self._instance.refresh())
            except Exception as err:  # noqa: BLE001 - keep serving with the last good values, whatever the provider raised
                self._log.warn(
                    "Secrets refresh failed, keeping the last good values: " + (str(err) or err.__class__.__name__)
                )
        finally:
            self._lock.release()
