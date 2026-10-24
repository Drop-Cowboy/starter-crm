"""Who the caller is: the identity step for server mode, and the bearer step for login mode.

Where it sits: ``app.py`` wraps each protected route with ``require_user()``
(server mode) or ``require_login`` (login mode). The identity provider chosen by
``DC_IDENTITY`` decides who the user is: ``dev`` (a fixed placeholder, for local
development), ``passcode`` (one shared passcode), ``oidc`` (a bearer JWT from
your identity provider), or your own file. To use your own login, write an
identity provider (see ``docs/providers/identity.md``) rather than editing this file.

The id the identity returns becomes the ``sub`` of every site token this
server mints. Drop Cowboy uses it for attribution only; your users never need a
Drop Cowboy login.

CONTRACT.md: "Identity routes", "CSRF".
"""

from __future__ import annotations

import functools
import re
from collections.abc import Callable
from dataclasses import dataclass

from flask import g, request

from .config import Config
from .errors import HttpError
from .security import check_origin

# The characters an OAuth bearer token may contain (RFC 6750).
BEARER = re.compile(r"Bearer +([A-Za-z0-9._~+/-]+=*) *", re.IGNORECASE)


@dataclass(frozen=True)
class User:
    """The signed-in person a route acts for; ``id`` is None when unknown."""

    id: str | None
    email: str | None = None
    name: str | None = None


def require_user(identity, config: Config) -> Callable:
    """Builds the decorator that decides who the signed-in user is in server mode.

    Side effects: sets ``g.user`` to a ``User`` on every request that passes. A
    cookie-authenticated request that is not a GET or HEAD (a POST or a DELETE) must also pass the CSRF origin check.

    Args:
        identity: The identity provider instance.
        config: The loaded config (the CSRF check reads the trusted origins from it).

    Returns:
        A decorator for a view.

    Raises:
        HttpError: From the decorated view: 401 ``unauthenticated``, 403 ``csrf_rejected``,
            or whatever the identity raises (401 ``invalid_token``, 503 ``identity_unavailable``).
    """

    def decorate(view: Callable) -> Callable:
        @functools.wraps(view)
        def identified(*args, **kwargs):
            found = identity.authenticate(request)
            if not found:
                challenge = getattr(identity, "challenge", None)
                raise HttpError(
                    401,
                    "unauthenticated",
                    "Sign in to use this app.",
                    {"WWW-Authenticate": challenge} if challenge else None,
                )
            if getattr(identity, "cookie_auth", False) and request.method not in ("GET", "HEAD"):
                check_origin(config)
            g.user = User(id=found.get("id"), email=found.get("email"), name=found.get("name"))
            return view(*args, **kwargs)

        return identified

    return decorate


def require_login(view: Callable) -> Callable:
    """Login mode only: sets ``g.access_token`` from ``Authorization: Bearer <token>``.

    The browser signed in with Drop Cowboy and sends that access token. This
    server does not check it. It forwards it to Drop Cowboy, which does, so a
    forged or expired token gets nothing. The token is never logged and never
    sent back.
    """

    @functools.wraps(view)
    def signed_in(*args, **kwargs):
        match = BEARER.fullmatch(request.headers.get("Authorization") or "")
        if match is None:
            raise HttpError(
                401,
                "login_required",
                "Sign in with Drop Cowboy, then send the access token as Authorization: Bearer <token>.",
            )
        g.access_token = match.group(1)
        return view(*args, **kwargs)

    return signed_in
