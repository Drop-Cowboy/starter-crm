"""``POST /api/dropcowboy/token``: mints a short-lived site token.

The browser names what it needs a token *for*; the server alone decides
which scopes that means. Never accept scopes from the browser: a page that
could ask for ``numbers:write`` could rent phone numbers on your account.

Ask for the least a page needs. Drop Cowboy only checks for a connected
carrier and a balance when the scopes include calling (``dialer:webrtc`` or
``phone:hub``), so the contacts pages use ``contacts`` and keep working for a
team that has neither.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Any, Callable

from flask import g, jsonify, request

from .config import Config
from .errors import HttpError
from .json_utils import is_number, parse_json
from .upstream import call_dropcowboy

PURPOSE_SCOPES = MappingProxyType(
    {
        "session": ("dialer:webrtc", "contacts"),
        "contacts": ("contacts",),
        "campaigns": ("campaigns",),
        "phone": ("phone:hub",),
    }
)

TOKEN_TTL_SECONDS = 900

JSON_WHITESPACE = " \t\n\r"


def scopes_for_purpose(purpose: Any) -> list[str] | None:
    """The scopes for ``purpose``, or None when it is not in the allowlist.

    A dict lookup only ever sees the dict's own keys, so "constructor" or
    "__proto__" cannot match the way they could on a JavaScript object. A
    non-string must still be rejected first: a list is not hashable.
    """
    if not isinstance(purpose, str) or purpose not in PURPOSE_SCOPES:
        return None
    return list(PURPOSE_SCOPES[purpose])


def token_view(config: Config) -> Callable:
    def mint_token():
        body = _json_body()
        purpose = body.get("purpose") if isinstance(body, dict) else None
        scope = scopes_for_purpose(purpose)
        if scope is None:
            raise HttpError(400, "invalid_purpose", "purpose must be one of: " + ", ".join(PURPOSE_SCOPES))

        # Login mode sends no sub: Drop Cowboy knows the user from their
        # token, and a sub the browser chose would be a claim nobody checked.
        access_token = g.get("access_token")
        if access_token:
            mint = {"site_id": config.site_id, "scope": scope, "ttl_seconds": TOKEN_TTL_SECONDS}
        else:
            mint = {"site_id": config.site_id, "sub": g.user.id, "scope": scope, "ttl_seconds": TOKEN_TTL_SECONDS}
        result = call_dropcowboy(config, "POST", "/phone/public/embed/token", mint, access_token=access_token)

        data = result.get("data") if isinstance(result, dict) else None
        if not isinstance(data, dict):
            data = {}
        token = data.get("token")
        expires_at = data.get("expires_at")
        if not isinstance(token, str) or token == "" or not is_number(expires_at):
            raise HttpError(502, "upstream_error", "Drop Cowboy sent a token response this server could not read.")

        response = jsonify({"token": token, "expires_at": expires_at})
        response.headers["Cache-Control"] = "no-store"
        return response

    return mint_token


def _json_body() -> Any:
    """The request body, parsed the way Express's ``express.json()`` does.

    Only ``application/json`` bodies are read, an empty body counts as ``{}``,
    and only an object or an array is accepted at the top level.
    """
    if request.mimetype != "application/json":
        return None
    text = request.get_data().decode("utf-8", errors="replace")
    stripped = text.strip(JSON_WHITESPACE)
    if stripped == "":
        return {}
    if stripped[0] not in "{[":
        raise HttpError(400, "invalid_json", "Request body is not valid JSON.")
    try:
        return parse_json(text)
    except ValueError:
        raise HttpError(400, "invalid_json", "Request body is not valid JSON.") from None
