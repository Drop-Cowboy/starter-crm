"""Observer hooks: lets your own code watch requests, errors, webhooks and token mints.

Where it sits: the app creates one ``Hooks`` object from the observer provider
(``DC_OBSERVER``) and calls it at the five points below. A hook that raises is
logged as a warning and ignored, so monitoring can never break a request.

In Python the hooks are plain synchronous calls: the WSGI server runs each
request on its own thread, so a slow hook stalls only that request.

CONTRACT.md: "Observer hooks".
What a customer changes: nothing; write an observer provider instead.
"""

from __future__ import annotations

from typing import Any


class Hooks:
    """Wraps an observer so every hook is safe to call."""

    def __init__(self, observer: Any, log: Any):
        """Creates the wrapper.

        Args:
            observer: The observer instance, or None for none.
            log: Where a failing hook is reported (needs ``warn``).
        """
        self._observer = observer
        self._log = log

    def _call(self, hook: str, payload: dict) -> None:
        method = getattr(self._observer, hook, None) if self._observer is not None else None
        if not callable(method):
            return
        try:
            method(payload)
        except Exception as err:  # noqa: BLE001 - an observer may raise anything; it must never break a request
            # The log line names the hook as the contract does (onWebhook), so one alert query covers both servers.
            name = hook.split("_")[0] + "".join(part.title() for part in hook.split("_")[1:])
            self._log.warn("Observer hook " + name + " failed: " + (str(err) or err.__class__.__name__))

    def on_request(self, payload: dict) -> None:
        """Calls the observer's ``on_request``: ``{request_id, method, path, client_ip}``."""
        self._call("on_request", payload)

    def on_response(self, payload: dict) -> None:
        """Calls the observer's ``on_response``: ``{request_id, method, path, status, duration_ms}``."""
        self._call("on_response", payload)

    def on_error(self, payload: dict) -> None:
        """Calls the observer's ``on_error``: ``{request_id, method, path, message}``."""
        self._call("on_error", payload)

    def on_webhook(self, payload: dict) -> None:
        """Calls the observer's ``on_webhook``: ``{request_id, event_id, event, duplicate}``."""
        self._call("on_webhook", payload)

    def on_token_minted(self, payload: dict) -> None:
        """Calls the observer's ``on_token_minted``: ``{request_id, user_id, purpose, cached, expires_at}``."""
        self._call("on_token_minted", payload)
