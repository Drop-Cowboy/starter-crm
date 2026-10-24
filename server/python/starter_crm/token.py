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

import hashlib
from collections.abc import Callable
from types import MappingProxyType
from typing import Any

from flask import g, jsonify

from .body import read_json_body
from .config import Config
from .errors import HttpError
from .json_utils import is_number
from .token_cache import TokenCache
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

# Mints allowed per user per minute (login mode: per access token). Cache hits do not count.
MINT_PER_USER_PER_MINUTE = 30


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
    """Builds the POST /api/dropcowboy/token view.

    Args:
        config: The loaded server config.

    Returns:
        A Flask view that mints a Drop Cowboy embed token for one purpose.

    Raises:
        HttpError: From the view: 400 ``invalid_purpose``, or the upstream error.
    """
    # Login mode never caches: the token is minted for whoever holds an access token.
    cache = TokenCache() if config.mode == "server" and config.token_cache else None

    def mint_token():
        body = read_json_body()
        purpose = body.get("purpose") if isinstance(body, dict) else None
        scope = scopes_for_purpose(purpose)
        if scope is None:
            raise HttpError(400, "invalid_purpose", "purpose must be one of: " + ", ".join(PURPOSE_SCOPES))

        user = g.get("user")
        user_id = user.id if user else None
        cache_key = f"{user_id}|{purpose}" if cache is not None else None
        hit = cache.get(cache_key) if cache is not None else None
        if hit is not None:
            g.hooks.on_token_minted(
                {
                    "request_id": g.request_id,
                    "user_id": user_id,
                    "purpose": purpose,
                    "cached": True,
                    "expires_at": hit["expires_at"],
                }
            )
            return _token_response(hit["token"], hit["expires_at"])

        # Only a request that will reach Drop Cowboy uses up the per-user allowance. In login
        # mode the caller is identified by their access token, hashed so it is never a map key.
        access_token = g.get("access_token")
        limit_key = hashlib.sha256(access_token.encode("utf-8")).hexdigest() if access_token else user_id
        g.limit("mint-user", limit_key, MINT_PER_USER_PER_MINUTE)

        # Login mode sends no sub: Drop Cowboy knows the user from their
        # token, and a sub the browser chose would be a claim nobody checked.
        if access_token:
            mint = {"site_id": config.site_id, "scope": scope, "ttl_seconds": TOKEN_TTL_SECONDS}
        else:
            mint = {"site_id": config.site_id, "sub": user_id, "scope": scope, "ttl_seconds": TOKEN_TTL_SECONDS}
        result = call_dropcowboy(config, "POST", "/phone/public/embed/token", mint, access_token=access_token)

        data = result.get("data") if isinstance(result, dict) else None
        if not isinstance(data, dict):
            data = {}
        token = data.get("token")
        expires_at = data.get("expires_at")
        if not isinstance(token, str) or token == "" or not is_number(expires_at):
            raise HttpError(502, "upstream_error", "Drop Cowboy sent a token response this server could not read.")

        if cache is not None:
            cache.set(cache_key, {"token": token, "expires_at": expires_at})
        g.hooks.on_token_minted(
            {
                "request_id": g.request_id,
                "user_id": user_id,
                "purpose": purpose,
                "cached": False,
                "expires_at": expires_at,
            }
        )
        return _token_response(token, expires_at)

    return mint_token


def _token_response(token: str, expires_at: float):
    """The documented body, marked ``no-store`` so no cache keeps a token."""
    response = jsonify({"token": token, "expires_at": expires_at})
    response.headers["Cache-Control"] = "no-store"
    return response
