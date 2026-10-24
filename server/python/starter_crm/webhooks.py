"""``POST /webhooks/dropcowboy``: verifies a signed Drop Cowboy webhook.

Drop Cowboy signs ``f"{X-Timestamp}.{body}"`` with HMAC-SHA256 and the
webhook's signing secret, and sends ``sha256=<hex>`` in X-Signature.
This must run on the exact bytes received: parsing the JSON and serialising
it again changes spacing or key order, and then nothing verifies. That is
why this route reads ``request.get_data()`` and never ``request.get_json()``.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import time
import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from flask import g, jsonify, request

from .config import Config
from .errors import HttpError
from .json_utils import is_number, parse_object

TOLERANCE_SECONDS = 300
DIGITS = re.compile(r"[0-9]+")


@dataclass(frozen=True)
class SignatureCheck:
    """The outcome of verifying one webhook delivery."""

    ok: bool
    code: str = ""
    message: str = ""


def verify_signature(
    raw_body: bytes,
    signature: str | None,
    timestamp: str | None,
    version: str | None,
    secrets: Sequence[str],
    now_seconds: int,
) -> SignatureCheck:
    """Checks a delivery's headers against its raw body.

    Each webhook has its own secret, so a delivery
    is valid if any configured secret matches.
    """
    if not signature or not timestamp:
        return SignatureCheck(False, "missing_signature", "X-Signature and X-Timestamp headers are required.")
    if version and version != "v1":
        return SignatureCheck(False, "invalid_signature", 'Unsupported X-Signature-Version "' + version + '".')
    if not DIGITS.fullmatch(timestamp) or abs(now_seconds - int(timestamp)) > TOLERANCE_SECONDS:
        return SignatureCheck(
            False, "stale_timestamp", "X-Timestamp is missing, malformed or more than 5 minutes from now."
        )

    received = signature.encode("utf-8")
    signed_bytes = timestamp.encode("ascii") + b"." + raw_body
    for secret in secrets:
        digest = hmac.new(secret.encode("utf-8"), signed_bytes, hashlib.sha256).hexdigest()
        expected = ("sha256=" + digest).encode("ascii")
        # compare_digest takes the same time wherever the first difference is.
        if hmac.compare_digest(received, expected):
            return SignatureCheck(True)
    return SignatureCheck(False, "invalid_signature", "Signature does not match. Check DROPCOWBOY_WEBHOOK_SECRET.")


def webhook_view(config: Config, runtime: Any) -> Callable:
    """Builds the POST /webhooks/dropcowboy view.

    The order is fixed, and it is what makes delivery safe:

    1. Verify the signature on the raw body.
    2. ``store.record()``: the event is stored before anything else happens.
    3. ``dispatcher.dispatch()``: queue the event id, or run the handlers inline.
    4. Answer 2xx.

    If step 2 or 3 fails the answer is 503 and the event stays ``received``, so Drop Cowboy's retry (or the
    maintenance sweep) picks it up. An event is never acknowledged unless it is both stored and queued. A repeat of
    an event id answers ``{"received": true, "duplicate": true}``; if the earlier copy never finished (still
    ``received``) its handlers are queued again, which is at-least-once delivery, so handlers must be idempotent.

    Args:
        config: The loaded server config; holds the signing secrets.
        runtime: The event runtime: its store records events and its dispatcher queues them.

    Returns:
        A Flask view that verifies the raw body, records and queues the event.

    Raises:
        HttpError: From the view: 413, 503 ``webhook_not_configured``, ``event_store_unavailable``,
            ``webhook_not_queued`` or ``handler_failed``, 401 signature failures, 400 malformed bodies.
    """
    store = runtime.store
    dispatcher = runtime.dispatcher

    def dispatch(event_id: str) -> None:
        """Queues an event's handlers and turns a failure into the 503 that makes Drop Cowboy retry.

        Args:
            event_id: The recorded event.

        Raises:
            HttpError: 503 when the event could not be queued, or an inline handler failed.
        """
        try:
            result = dispatcher.dispatch(event_id)
        except Exception as err:  # noqa: BLE001 - any queue failure must become a retryable 503
            g.log.error("Could not queue event " + event_id + ":", str(err) or err.__class__.__name__)
            raise HttpError(
                503, "webhook_not_queued", "The event was stored but could not be queued. Drop Cowboy will retry."
            ) from err
        if result.get("outcome") == "retry":
            raise HttpError(503, "handler_failed", "A webhook handler failed. Drop Cowboy will retry.")

    def receive_webhook():
        # Read first, so a body over 1 MB is 413 whatever else is wrong.
        raw_body = request.get_data()
        if not config.webhook_secrets:
            raise HttpError(503, "webhook_not_configured", "Set DROPCOWBOY_WEBHOOK_SECRET to receive webhooks.")

        check = verify_signature(
            raw_body=raw_body,
            signature=request.headers.get("X-Signature"),
            timestamp=request.headers.get("X-Timestamp"),
            version=request.headers.get("X-Signature-Version"),
            secrets=config.webhook_secrets,
            now_seconds=int(time.time()),
        )
        if not check.ok:
            g.log.warn("Rejected webhook:", check.code)
            raise HttpError(401, check.code, check.message)

        body = parse_object(raw_body.decode("utf-8", errors="replace"))
        if body is None:
            raise HttpError(400, "invalid_json", "Webhook body is not a JSON object.")

        # Drop Cowboy retries with the same event id, so the store keeps one copy of each.
        body_event_id = body.get("event_id") if isinstance(body.get("event_id"), str) else None
        event_id = request.headers.get("X-Event-Id") or body_event_id or str(uuid.uuid4())
        event = {
            "event_id": event_id,
            "event": body.get("event") if isinstance(body.get("event"), str) else None,
            "event_at": body.get("event_at") if is_number(body.get("event_at")) else None,
            "received_at": int(time.time() * 1000),
            "attempt": _attempt(request.headers.get("X-Attempt")),
            "data": body.get("data") if isinstance(body.get("data"), (dict, list)) else {},
        }
        event_name = event["event"]
        try:
            recorded = store.record(
                event, visible_at=int(time.time() * 1000) + getattr(dispatcher, "visible_delay_ms", 0)
            )
        except Exception as err:  # noqa: BLE001 - any store failure must become a retryable 503
            g.log.error("Could not store event " + event_id + ":", str(err) or err.__class__.__name__)
            raise HttpError(
                503, "event_store_unavailable", "The event could not be stored. Drop Cowboy will retry."
            ) from err

        if not recorded["inserted"]:
            # A copy that never finished gets its handlers queued again; a finished one is just acknowledged.
            if recorded["status"] == "received":
                dispatch(event_id)
            g.hooks.on_webhook(
                {"request_id": g.request_id, "event_id": event_id, "event": event_name, "duplicate": True}
            )
            return jsonify({"received": True, "duplicate": True})

        dispatch(event_id)
        g.log.info("Webhook", body.get("event") or "(no event type)", event_id)
        g.hooks.on_webhook({"request_id": g.request_id, "event_id": event_id, "event": event_name, "duplicate": False})
        return jsonify({"received": True})

    return receive_webhook


def webhook_status_view(config: Config, runtime: Any) -> Callable:
    """``GET /api/webhooks/status``: how webhook handling is doing, for the Setup page and ``doctor``.

    Args:
        config: Validated config (``events.store``, ``events.webhooks``).
        runtime: The event runtime; its store supplies the counts.

    Returns:
        A Flask view answering the counts of events by state.

    Raises:
        HttpError: From the view: 503 ``event_store_unavailable`` when the store cannot be read.
    """
    store = runtime.store

    def webhook_status():
        try:
            counts = store.counts()
        except Exception as err:  # noqa: BLE001 - any store failure must become a retryable 503
            g.log.error("Could not read event counts:", str(err) or err.__class__.__name__)
            raise HttpError(503, "event_store_unavailable", "The event store could not be read.") from err
        return jsonify(
            {
                "store": config.events.store,
                "webhooks": config.events.webhooks,
                "max_attempts": config.events.max_attempts,
                "received": counts["received"],
                "processed": counts["processed"],
                "failed": counts["failed"],
                "oldest_received_age_seconds": counts["oldest_received_age_seconds"],
            }
        )

    return webhook_status


def _attempt(header: str | None) -> int:
    """X-Attempt as a positive integer, else 1."""
    if header and DIGITS.fullmatch(header.strip()) and int(header) > 0:
        return int(header)
    return 1
