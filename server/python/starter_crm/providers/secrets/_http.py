"""Shared plumbing for the secrets providers that talk to a manager's REST API.

Where it sits: ``doppler``, ``infisical`` and ``vault`` call ``validate_base_url()``
from their ``validate()`` and ``request_json()`` from ``load()`` and ``refresh()``.
It exists so the three behave identically where it matters for secrets, and
identically to the Node server:

- The address must be https. Plain http is accepted only for a loopback host
  (127.0.0.1, ::1, localhost), which is how a local OpenBao or a test stub is
  reached. A bearer token must not cross a network in clear text.
- Redirects are an error. A redirect would forward the credential to whatever
  host answered, so a response that tries one is reported instead.
- Every call has a timeout, because the first call happens at boot and a hung
  secrets manager must fail the boot, not freeze it.
- Errors say what the manager answered (an HTTP status) or why it could not be
  reached, and never include a URL's query, a header or a response body.

CONTRACT.md: "Providers" (secrets).
What a customer changes: nothing.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlsplit

from ...problems import BootProblem, problem

# How long one call to a secrets manager may take, in seconds.
REQUEST_TIMEOUT_SECONDS = 10


class ManagerError(Exception):
    """A secrets manager call failed.

    Attributes:
        status: The HTTP status the manager answered, or None when it could not be reached.
    """

    def __init__(self, message: str, status: int | None = None):
        """Creates the error.

        Args:
            message: What to tell the operator; never contains a credential or a response body.
            status: The HTTP status, when there was one.
        """
        super().__init__(message)
        self.status = status


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """Turns every redirect into an error instead of following it."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        """Refuses the redirect; ``urlopen`` then raises the 3xx as an ``HTTPError``."""
        return None


_OPENER = urllib.request.build_opener(_RefuseRedirects)


def validate_base_url(variable: str, value: str) -> BootProblem | None:
    """Checks a manager address setting is a usable base URL.

    Args:
        variable: The setting's name, for the message.
        value: The address, as set.

    Returns:
        A boot problem, or None when the address is fine.
    """
    fix = (
        "Set "
        + variable
        + " to an https address such as https://secrets.example.com (http is allowed only for localhost)."
    )
    try:
        parts = urlsplit(value)
        hostname = parts.hostname
    except ValueError:
        return problem("invalid_secrets_url", variable + " is not a valid URL.", fix)
    if parts.scheme not in ("http", "https") or not hostname:
        return problem("invalid_secrets_url", variable + " is not a valid URL.", fix)
    loopback = hostname in ("localhost", "127.0.0.1", "::1")
    if parts.scheme != "https" and not loopback:
        return problem(
            "invalid_secrets_url",
            variable + " must be an https address; " + parts.scheme + ":// would send credentials in clear text.",
            fix,
        )
    if parts.username or parts.password:
        return problem("invalid_secrets_url", variable + " must not contain a user name or password.", fix)
    return None


def request_json(
    label: str,
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    body: Any = None,
) -> Any:
    """Calls a manager's REST API and parses the JSON it answers.

    Args:
        label: How errors name the manager, for example "Doppler".
        url: The full URL.
        method: The HTTP method.
        headers: Extra headers, such as the credential.
        body: An optional value sent as JSON.

    Returns:
        The parsed JSON body.

    Raises:
        ManagerError: On any non-2xx answer (with its ``status``), a refused redirect, a timeout,
            a connection failure, or a body that is not JSON.
    """
    data = None if body is None else json.dumps(body).encode("utf-8")
    request_headers = {"Accept": "application/json", **(headers or {})}
    if data is not None:
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, method=method, headers=request_headers)  # noqa: S310 - scheme checked by validate_base_url
    try:
        with _OPENER.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            payload = response.read()
    except urllib.error.HTTPError as err:
        if 300 <= err.code < 400:
            raise ManagerError(
                label + " tried to redirect the request, which is refused so the credential is not forwarded",
                err.code,
            ) from None
        raise ManagerError(label + " answered HTTP " + str(err.code), err.code) from None
    except TimeoutError:
        raise ManagerError(label + " did not answer within " + str(REQUEST_TIMEOUT_SECONDS) + " seconds") from None
    except urllib.error.URLError as err:
        if isinstance(err.reason, TimeoutError):
            raise ManagerError(label + " did not answer within " + str(REQUEST_TIMEOUT_SECONDS) + " seconds") from None
        raise ManagerError(label + " could not be reached") from None
    try:
        return json.loads(payload)
    except ValueError:
        raise ManagerError(label + " answered something that is not JSON") from None


def pick(everything: Any, names: list[str]) -> dict[str, str]:
    """Keeps only the secrets asked for, and only the ones that hold text.

    Args:
        everything: What a manager returned.
        names: The names the starter asked for.

    Returns:
        The requested names that have a non-empty string value.
    """
    if not isinstance(everything, dict):
        return {}
    return {key: everything[key] for key in names if isinstance(everything.get(key), str) and everything[key] != ""}
