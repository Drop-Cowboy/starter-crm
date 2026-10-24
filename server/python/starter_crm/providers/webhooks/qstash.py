"""The ``qstash`` webhook mode: Upstash QStash delivers each event id back to this server.

Where it sits: ``DC_WEBHOOKS=qstash``, the queue for any host with a public address. The webhook records the event in
the store, publishes a message to QStash and answers 200 only after QStash has accepted it. A message carries just the
``event_id`` (and the site), never the contact's data. QStash then calls ``POST /internal/webhook-jobs`` on this
server, which verifies QStash's signature, reads the event from the store and runs the handlers. The Node server
speaks the same messages and the same route.

- There is no worker: nothing runs between requests. ``start()`` and ``stop()`` do nothing.
- The route runs nothing before it has verified the ``Upstash-Signature`` header (an HS256 token) against the current
  and the next signing key, so a key rotation never drops a message, then the body hash and the destination URL.
  Anything else is 401.
- When a handler fails and another attempt is due, the route answers 503 and QStash retries after the backoff the
  publish asked for (1 s, 2 s, 4 s, up to 5 minutes). QStash gives up after its own retry limit; the event then stays
  ``received`` and the maintenance run re-queues it.
- Delivery is at least once, so handlers must be idempotent, as for every webhook mode.

Dispatcher interface: see ``store.py``. ``routes()`` adds the internal route to the app.

CONTRACT.md: "POST /webhooks/dropcowboy" (Processing), "Internal routes".
Env: QSTASH_TOKEN, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY, QSTASH_URL, DC_PUBLIC_URL (on Vercel and
Netlify the site's own address is the default).
What a customer changes: nothing.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import time
import urllib.error
import urllib.request
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit

from flask import g, jsonify, request

from ...errors import HttpError
from ...problems import BootProblem, problem

name = "qstash"
config_keys = [
    "QSTASH_TOKEN",
    "QSTASH_URL",
    "QSTASH_CURRENT_SIGNING_KEY",
    "QSTASH_NEXT_SIGNING_KEY",
    "DC_PUBLIC_URL",
    "VERCEL_PROJECT_PRODUCTION_URL",
    "NETLIFY",
    "URL",
]

# The route QStash calls.
JOBS_PATH = "/internal/webhook-jobs"

# QStash's hosted address; a regional account sets QSTASH_URL.
DEFAULT_BASE_URL = "https://qstash.upstash.io"

# QStash waits this long between retries: 1 s, 2 s, 4 s, up to 5 minutes, like every other mode.
RETRY_DELAY = "min(300000, pow(2, retried) * 1000)"

# How long a publish may take, in seconds.
PUBLISH_TIMEOUT_SECONDS = 10


def _read(env: Mapping[str, str], key: str) -> str:
    """A trimmed variable, treating blank as unset."""
    value = env.get(key)
    return value.strip() if isinstance(value, str) else ""


def public_origin(env: Mapping[str, str]) -> str:
    """The public origin QStash calls: ``DC_PUBLIC_URL``, or the site's main address on Vercel or Netlify.

    ``URL`` is a common name for unrelated settings, so it is only read when ``NETLIFY`` says Netlify set it.

    Args:
        env: The merged environment.

    Returns:
        The origin without a trailing slash, or ``""`` when none is set.
    """
    explicit = _read(env, "DC_PUBLIC_URL")
    if explicit:
        return explicit.rstrip("/")
    vercel = _read(env, "VERCEL_PROJECT_PRODUCTION_URL")
    if vercel:
        return "https://" + vercel
    return _read(env, "URL").rstrip("/") if _read(env, "NETLIFY") else ""


def _is_url(value: str) -> bool:
    """Whether ``value`` is an http(s) URL with a host."""
    try:
        parts = urlsplit(value)
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and bool(parts.hostname)


def validate(env: Mapping[str, str]) -> list[BootProblem]:
    """Checks the token, both signing keys and the public address.

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    problems: list[BootProblem] = []
    where = "Copy it from the QStash page of the Upstash console (the Vercel integration sets it for you)."
    for key in ("QSTASH_TOKEN", "QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY"):
        if not _read(env, key):
            problems.append(
                problem(
                    "missing_qstash_setting",
                    "DC_WEBHOOKS=qstash needs " + key + ".",
                    "Set " + key + ". " + where,
                )
            )
    origin = public_origin(env)
    if not origin:
        problems.append(
            problem(
                "missing_qstash_public_url",
                "DC_WEBHOOKS=qstash needs DC_PUBLIC_URL: QStash has to know where to send each event.",
                "Set DC_PUBLIC_URL to your site's public origin, for example https://crm.example.com.",
            )
        )
    elif not _is_url(origin):
        problems.append(
            problem(
                "invalid_qstash_public_url",
                'DC_PUBLIC_URL is not a URL (got "' + origin + '").',
                "Set DC_PUBLIC_URL to your site's public origin, for example https://crm.example.com.",
            )
        )
    elif env.get("DC_ENV") == "production" and urlsplit(origin).scheme != "https":
        problems.append(
            problem(
                "insecure_qstash_public_url",
                "DC_PUBLIC_URL must use https:// in production, because QStash sends your events there.",
                "Use the https:// address of your site.",
            )
        )
    base = _read(env, "QSTASH_URL")
    if base and not _is_url(base):
        problems.append(
            problem(
                "invalid_qstash_url",
                'QSTASH_URL is not a URL (got "' + base + '").',
                "Unset it for the default region, or set the regional address from the Upstash console.",
            )
        )
    return problems


def _b64url_decode(text: str) -> bytes:
    """Decodes unpadded base64url, raising ``ValueError`` when it is not."""
    try:
        return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))
    except (binascii.Error, ValueError) as err:
        raise ValueError("not base64url") from err


def verify_signature(signature: str, body: bytes, url: str, keys: list[str], now: float | None = None) -> bool:
    """Checks a QStash ``Upstash-Signature`` token.

    The token is an HS256 JWT. It is valid when one of ``keys`` signed it, it was issued by ``Upstash``, it is within
    its ``nbf`` and ``exp`` window, its ``sub`` is ``url`` and its ``body`` claim is the SHA-256 of ``body``.

    Args:
        signature: The header value.
        body: The exact request bytes.
        url: The address QStash was told to call.
        keys: The current and next signing keys.
        now: Epoch seconds, for tests.

    Returns:
        True only for a valid, current signature made for this body and address.
    """
    parts = signature.split(".")
    if len(parts) != 3:
        return False
    try:
        header = json.loads(_b64url_decode(parts[0]))
        claims = json.loads(_b64url_decode(parts[1]))
        given = _b64url_decode(parts[2])
    except ValueError:
        return False
    if not isinstance(header, dict) or header.get("alg") != "HS256" or not isinstance(claims, dict):
        return False
    signed = (parts[0] + "." + parts[1]).encode("ascii", errors="ignore")
    if not any(hmac.compare_digest(hmac.new(key.encode(), signed, hashlib.sha256).digest(), given) for key in keys):
        return False
    moment = time.time() if now is None else now
    expires, not_before = claims.get("exp"), claims.get("nbf")
    if claims.get("iss") != "Upstash" or claims.get("sub") != url:
        return False
    if not isinstance(expires, (int, float)) or moment >= expires:
        return False
    if isinstance(not_before, (int, float)) and moment < not_before:
        return False
    wanted = hashlib.sha256(body).digest()
    claimed = claims.get("body")
    if not isinstance(claimed, str):
        return False
    try:
        return hmac.compare_digest(_b64url_decode(claimed.rstrip("=")), wanted)
    except ValueError:
        return False


class QstashDispatcher:
    """Publishes event ids to QStash and handles the calls it makes back."""

    visible_delay_ms = 120000

    def __init__(self, config: Any, env: Mapping[str, str], processor: Any, log: Any, opener: Any = None):
        """Prepares the dispatcher; nothing connects until the first ``dispatch()``.

        Args:
            config: The loaded config (site id).
            env: The merged environment (token, signing keys, addresses).
            processor: The processor that runs handlers.
            log: The redacting logger.
            opener: A ``urlopen``-like callable, for tests.
        """
        self._config = config
        self._processor = processor
        self._log = log
        self._token = _read(env, "QSTASH_TOKEN")
        self._base = (_read(env, "QSTASH_URL") or DEFAULT_BASE_URL).rstrip("/")
        self._keys = [_read(env, "QSTASH_CURRENT_SIGNING_KEY"), _read(env, "QSTASH_NEXT_SIGNING_KEY")]
        self._destination = public_origin(env) + JOBS_PATH
        self._site_id = getattr(config, "site_id", None) or "default"
        self._open = opener or urllib.request.urlopen

    def dispatch(self, event_id: str) -> dict:
        """Publishes one event id and says it was queued.

        Args:
            event_id: The recorded event.

        Returns:
            ``{"outcome": "queued"}``.

        Raises:
            RuntimeError: When QStash did not accept the message.
        """
        body = json.dumps({"event_id": event_id, "site_id": self._site_id}).encode()
        req = urllib.request.Request(  # noqa: S310 - the address comes from DC_PUBLIC_URL / QSTASH_URL, validated at boot
            self._base + "/v2/publish/" + self._destination,
            data=body,
            method="POST",
            headers={
                "Authorization": "Bearer " + self._token,
                "Content-Type": "application/json",
                "Upstash-Method": "POST",
                "Upstash-Retry-Delay": RETRY_DELAY,
            },
        )
        try:
            with self._open(req, timeout=PUBLISH_TIMEOUT_SECONDS) as response:
                response.read()
        except urllib.error.HTTPError as err:
            raise RuntimeError("QStash refused the message (HTTP " + str(err.code) + ").") from err
        except (urllib.error.URLError, OSError) as err:
            raise RuntimeError("QStash could not be reached: " + str(err)) from err
        return {"outcome": "queued"}

    def sweep(self, event_ids: list[str]) -> None:
        """Re-queues events by publishing them again.

        Args:
            event_ids: Events no worker finished.
        """
        for event_id in event_ids:
            self.dispatch(event_id)

    def routes(self) -> list[dict]:
        """The route QStash calls back.

        Returns:
            One ``{"method", "path", "handler"}`` for the app to register.
        """
        return [{"method": "POST", "path": JOBS_PATH, "handler": self._jobs}]

    def _jobs(self):
        """The route QStash calls: verify, then run the event's handlers.

        Returns:
            200 when the event is finished.

        Raises:
            HttpError: 401 ``invalid_signature``, 503 ``handler_failed`` when QStash should retry.
        """
        raw = request.get_data()
        signature = request.headers.get("Upstash-Signature") or ""
        if not signature or not verify_signature(signature, raw, self._destination, self._keys):
            g.log.warn("Rejected a QStash call with a missing or invalid signature.")
            raise HttpError(
                401, "invalid_signature", "The Upstash-Signature header is missing or does not match the signing keys."
            )
        event_id = ""
        try:
            parsed = json.loads(raw.decode("utf-8"))
            if isinstance(parsed, dict) and isinstance(parsed.get("event_id"), str):
                event_id = parsed["event_id"]
        except ValueError:
            pass
        if event_id == "":
            # Only this server publishes here, so this never retries into success: drop it.
            g.log.warn("Dropping a QStash message that is not an event id.")
            return jsonify({"ignored": True})
        result = self._processor.process(event_id)
        if result.get("outcome") == "retry":
            raise HttpError(503, "handler_failed", "A webhook handler failed. QStash will retry.")
        return jsonify({"outcome": result.get("outcome")})

    def start(self) -> None:
        """Nothing runs between requests."""

    def stop(self) -> None:
        """Nothing to stop."""

    def ready(self) -> bool:
        """Always ready: QStash has no cheap probe, and a publish failure is a 503 the sender retries."""
        return True


def create(ctx: Any, opener: Any = None) -> QstashDispatcher:
    """Creates the dispatcher.

    Args:
        ctx: The provider context (``config``, ``env``, ``processor``, ``log``).
        opener: A ``urlopen``-like callable, for tests.

    Returns:
        The dispatcher instance.
    """
    return QstashDispatcher(ctx.config, ctx.env, ctx.processor, ctx.log, opener)
