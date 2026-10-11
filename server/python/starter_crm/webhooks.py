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
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Callable

from flask import jsonify, request

from .config import Config
from .errors import HttpError
from .events import EventStore
from .json_utils import is_number, parse_object
from .log import Logger

TOLERANCE_SECONDS = 300
DIGITS = re.compile(r"[0-9]+")


@dataclass(frozen=True)
class SignatureCheck:
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


def webhook_view(config: Config, store: EventStore, log: Logger) -> Callable:
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
            log.warn("Rejected webhook:", check.code)
            raise HttpError(401, check.code, check.message)

        body = parse_object(raw_body.decode("utf-8", errors="replace"))
        if body is None:
            raise HttpError(400, "invalid_json", "Webhook body is not a JSON object.")

        # Drop Cowboy retries with the same event id, so skip ids already seen.
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
        if not store.add(event):
            return jsonify({"received": True, "duplicate": True})

        log.info("Webhook", body.get("event") or "(no event type)", event_id)
        return jsonify({"received": True})

    return receive_webhook


def _attempt(header: str | None) -> int:
    """X-Attempt as a positive integer, else 1."""
    if header and DIGITS.fullmatch(header.strip()) and int(header) > 0:
        return int(header)
    return 1
