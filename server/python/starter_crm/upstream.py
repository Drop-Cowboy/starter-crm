"""Every call to the Drop Cowboy API.

Uses the standard library's ``urllib`` so you can see each request the
starter makes. Every failure becomes an ``HttpError`` in the contract's
envelope.
"""

from __future__ import annotations

import http.client
import json
import socket
import urllib.error
import urllib.request
from typing import Any

from .config import Config
from .errors import HttpError, from_upstream
from .json_utils import parse_json

USER_AGENT = "dropcowboy-starter-crm/0.1 (python)"


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

    request = urllib.request.Request(config.api_base + path, data=data, headers=headers, method=method)
    status, response_headers, raw = _send(request, config.timeout_ms / 1000)
    json_body = _parse_or_none(raw)

    # The user's sign-in, not this server's key, was refused: the browser
    # should sign in again, so this stays a 401.
    if status == 401 and access_token:
        raise HttpError(401, "login_expired", "Your Drop Cowboy sign-in has expired. Sign in again.")
    if not 200 <= status < 300:
        raise from_upstream(status, json_body, response_headers)
    if json_body is None:
        raise HttpError(502, "upstream_error", "Drop Cowboy sent a response this server could not read.")
    return json_body


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
    # socket.timeout and TimeoutError are separate classes on Python 3.9.
    if isinstance(reason, (socket.timeout, TimeoutError)):
        return HttpError(504, "upstream_timeout", "Drop Cowboy did not answer in time. Try again shortly.")
    return HttpError(502, "upstream_unreachable", "This server could not reach Drop Cowboy.")


def _parse_or_none(raw: bytes) -> Any:
    if not raw:
        return None
    try:
        return parse_json(raw.decode("utf-8", errors="replace"))
    except ValueError:
        return None
