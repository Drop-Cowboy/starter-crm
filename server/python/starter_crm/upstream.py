"""Every call to the Drop Cowboy API.

Uses the standard library's ``urllib`` so you can see each request the
starter makes. Every failure becomes an ``HttpError`` in the contract's
envelope.
"""

from __future__ import annotations

import http.client
import json
import math
import random
import time
import urllib.error
import urllib.request
from typing import Any

from .config import Config
from .errors import HttpError, from_upstream
from .json_utils import parse_json

USER_AGENT = "dropcowboy-starter-crm/0.1 (python)"

# Reads are tried at most this many times in total.
MAX_READ_ATTEMPTS = 3

# The first backoff ceiling; each retry doubles it.
BASE_BACKOFF_SECONDS = 0.150

# Extra random wait added after a Retry-After, so callers throttled together do not return together.
JITTER_SECONDS = 0.100

# A Retry-After longer than this is passed to the caller instead of waited out.
MAX_RETRY_AFTER_SECONDS = 2


class RedirectRefused(urllib.error.URLError):
    """Raised instead of following a redirect from Drop Cowboy."""


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """Following a redirect would resend the credentials to wherever it points."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        fp.close()
        raise RedirectRefused("Drop Cowboy answered with a redirect, which this server does not follow.")


# ProxyHandler({}) ignores HTTP(S)_PROXY and the system proxy settings, so the
# API key goes straight to DROPCOWBOY_API_BASE and nowhere else.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _RefuseRedirects())


def call_dropcowboy(config: Config, method: str, path: str, body: Any = None, access_token: str | None = None) -> Any:
    """Calls ``{DROPCOWBOY_API_BASE}{path}`` with this server's API key.

    When ``access_token`` is given (login mode) it authenticates with the
    signed-in user's token instead. Never both.

    Reads (``GET``) are retried up to 3 attempts in total, after a network
    error, a 5xx, or a 429 whose ``Retry-After`` is 2 seconds or less.
    Timeouts, other 4xx answers, and every non-GET call are never retried.

    Returns the parsed JSON body of a 2xx answer. Raises ``HttpError`` for
    everything else: an error answer, a timeout, or no answer at all.
    """
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if access_token:
        headers["Authorization"] = "Bearer " + access_token
    else:
        headers["x-key"] = config.api_key or ""
        headers["x-secret"] = config.api_secret or ""
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")

    # Only reads are retried. A mint or any write could repeat a side effect if
    # the first attempt reached Drop Cowboy but its answer was lost.
    max_attempts = MAX_READ_ATTEMPTS if method == "GET" else 1
    attempt = 0
    while True:
        attempt += 1
        request = urllib.request.Request(config.api_base + path, data=data, headers=headers, method=method)
        try:
            status, response_headers, raw = _send(request, config.timeout_ms / 1000)
        except HttpError as err:
            if attempt >= max_attempts or err.code != "upstream_unreachable":
                raise
            time.sleep(_backoff_seconds(attempt))
            continue
        wait = _retry_delay_seconds(status, response_headers, attempt)
        if wait is None or attempt >= max_attempts:
            return _interpret(status, response_headers, _parse_or_none(raw), access_token)
        time.sleep(wait)


def fetch_json(url: str, timeout_seconds: float) -> Any:
    """Fetches a public JSON document, such as an OIDC key set. No credentials are sent.

    Redirects are refused and system proxies ignored, as for every other call here.

    Args:
        url: The document's URL.
        timeout_seconds: How long to wait.

    Returns:
        The parsed JSON.

    Raises:
        HttpError: 503 ``identity_unavailable`` when the document cannot be fetched or read.
    """
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
    unavailable = HttpError(
        503, "identity_unavailable", "The sign-in provider could not be reached. Try again shortly."
    )
    try:
        status, _headers, raw = _send(request, timeout_seconds)
    except HttpError:
        raise unavailable from None
    parsed = _parse_or_none(raw) if 200 <= status < 300 else None
    if parsed is None:
        raise unavailable
    return parsed


def _interpret(status: int, headers: Any, json_body: Any, access_token: str | None) -> Any:
    """Turns the final answer into a result or an error."""
    # The user's sign-in, not this server's key, was refused: the browser
    # should sign in again, so this stays a 401.
    if status == 401 and access_token:
        raise HttpError(401, "login_expired", "Your Drop Cowboy sign-in has expired. Sign in again.")
    if not 200 <= status < 300:
        raise from_upstream(status, json_body, headers)
    if json_body is None:
        raise HttpError(502, "upstream_error", "Drop Cowboy sent a response this server could not read.")
    return json_body


def _retry_delay_seconds(status: int, headers: Any, attempt: int) -> float | None:
    """Whether an answer is worth another attempt, and how long to wait first, or None to stop."""
    if status >= 500:
        return _backoff_seconds(attempt)
    if status == 429:
        try:
            seconds = float(headers.get("Retry-After"))
        except (TypeError, ValueError):
            return None
        # A short throttle is worth waiting out; a long one is the caller's to hear about.
        if math.isfinite(seconds) and 0 <= seconds <= MAX_RETRY_AFTER_SECONDS:
            return seconds + random.uniform(0, JITTER_SECONDS)
    return None


def _backoff_seconds(attempt: int) -> float:
    """Exponential backoff with jitter, so many callers do not retry in lockstep."""
    ceiling = BASE_BACKOFF_SECONDS * 2 ** (attempt - 1)
    return ceiling / 2 + random.uniform(0, ceiling / 2)


def _send(request: urllib.request.Request, timeout_seconds: float):
    """Returns ``(status, headers, body bytes)`` for any HTTP answer, error statuses included."""
    try:
        response = _OPENER.open(request, timeout=timeout_seconds)
    except urllib.error.HTTPError as err:
        # urllib raises for 4xx and 5xx, but they are still answers to read.
        response = err
    except (OSError, http.client.HTTPException) as err:
        raise _network_error(err) from None

    try:
        with response:
            return response.getcode(), response.headers, response.read()
    except (OSError, http.client.HTTPException) as err:
        raise _network_error(err) from None


def _network_error(err: Exception) -> HttpError:
    reason = err.reason if isinstance(err, urllib.error.URLError) else err
    if isinstance(reason, TimeoutError):
        return HttpError(504, "upstream_timeout", "Drop Cowboy did not answer in time. Try again shortly.")
    return HttpError(502, "upstream_unreachable", "This server could not reach Drop Cowboy.")


def _parse_or_none(raw: bytes) -> Any:
    if not raw:
        return None
    try:
        return parse_json(raw.decode("utf-8", errors="replace"))
    except ValueError:
        return None
