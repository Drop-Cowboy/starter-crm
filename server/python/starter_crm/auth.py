"""REPLACE WITH YOUR AUTH.

``require_user()`` stands in for your CRM's own login. As shipped it lets
every request through as the user in STARTER_CRM_USER_ID, which is only safe on
your own machine. In your app, verify the session cookie or bearer token
here, answer 401 when there is none, and set ``g.user`` to your user.

That id becomes the ``sub`` of every site token this server mints. Drop
Cowboy uses it for attribution only; your users never need a Drop Cowboy
login.
"""

from __future__ import annotations

import functools
import re
from dataclasses import dataclass
from typing import Callable

from flask import g, request

from .config import Config
from .errors import HttpError

# The characters an OAuth bearer token may contain (RFC 6750).
BEARER = re.compile(r"Bearer +([A-Za-z0-9._~+/-]+=*) *", re.IGNORECASE)


@dataclass(frozen=True)
class User:
    id: str | None


def require_user(config: Config) -> Callable:
    """A decorator that sets ``g.user`` before the view runs."""

    def decorate(view: Callable) -> Callable:
        @functools.wraps(view)
        def placeholder_user(*args, **kwargs):
            g.user = User(id=config.starter_user_id)
            return view(*args, **kwargs)

        return placeholder_user

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
