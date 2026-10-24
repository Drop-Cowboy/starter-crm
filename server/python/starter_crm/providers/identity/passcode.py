"""The ``passcode`` identity: one shared passcode unlocks the app.

Where it sits: the default for one-click deploys. Someone who knows
``DC_PASSCODE`` signs in once and gets a signed, HttpOnly session cookie
lasting 12 hours; every protected route then treats them as one owner. It is a
gate, not an account system: swap in ``oidc`` or your own provider when you
need separate users.

The cookie is ``base64url(JSON {v, sub, iat, exp}).base64url(HMAC-SHA256)``.
The HMAC key is derived from the passcode and site id, so changing the
passcode signs everyone out and no separate session secret is needed. There is
no server-side session list, so signing out only clears the cookie. Rotate the
passcode to revoke every session at once.

CONTRACT.md: "Identity routes", "CSRF".
Env: DC_PASSCODE (at least 12 characters), DROPCOWBOY_SITE_ID,
STARTER_CRM_USER_ID (optional: names the one owner), DC_ENV.
What a customer changes: nothing.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import re
import time
import uuid

from flask import g, jsonify, request

from ...body import read_json_body
from ...errors import HttpError
from ...problems import BootProblem, problem
from ...security import check_origin

name = "passcode"
config_keys = ["DC_PASSCODE"]

# The shortest passcode accepted: below 12 characters a guesser's 10-a-minute budget still adds up.
MIN_PASSCODE_LENGTH = 12

# How long a session lasts: 12 hours, a working day, then sign in again.
SESSION_SECONDS = 12 * 60 * 60

# Sign-in attempts per client IP per minute.
SIGN_IN_LIMIT = 10

# Cookie format version, so a future change can reject old cookies cleanly.
COOKIE_VERSION = 1

# A JSON content type, with a word boundary so "application/jsonx" does not count.
JSON_TYPE = re.compile(r"application/json\b", re.IGNORECASE)


def validate(env) -> list[BootProblem]:
    """Checks ``DC_PASSCODE``.

    Args:
        env: The merged environment.

    Returns:
        Boot problems; none of them contain the passcode.
    """
    passcode = (env.get("DC_PASSCODE") or "").strip()
    if not passcode:
        return [
            problem(
                "missing_passcode",
                "DC_IDENTITY=passcode needs DC_PASSCODE.",
                "Set DC_PASSCODE to a passcode of at least " + str(MIN_PASSCODE_LENGTH) + " characters.",
            )
        ]
    if len(passcode) < MIN_PASSCODE_LENGTH:
        return [
            problem(
                "weak_passcode",
                "DC_PASSCODE must be at least " + str(MIN_PASSCODE_LENGTH) + " characters.",
                "Use a longer passcode, for example three random words.",
            )
        ]
    return []


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64url(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _read_cookie(header: str | None, cookie_name: str) -> str | None:
    """Reads one cookie out of a ``Cookie`` header, the way the Node provider does."""
    if not header:
        return None
    for part in header.split(";"):
        index = part.find("=")
        if index > 0 and part[:index].strip() == cookie_name:
            return part[index + 1 :].strip()
    return None


def _constant_time_equal(a: str, b: str) -> bool:
    """Compares two strings without leaking where they differ: both are hashed first so the lengths match."""
    left = hashlib.sha256(a.encode("utf-8")).digest()
    right = hashlib.sha256(b.encode("utf-8")).digest()
    return hmac.compare_digest(left, right)


class PasscodeIdentity:
    """Signs a session cookie for the owner and verifies it on later requests."""

    cookie_auth = True

    def __init__(self, config):
        """Derives the signing key and the owner id from the config.

        Args:
            config: The loaded config (``passcode``, ``site_id``, ``env``, ``starter_user_id``).
        """
        self._config = config
        self._production = config.env == "production"
        # `__Host-` makes browsers refuse a cookie that is not Secure, has a Domain, or a Path other than /.
        self._cookie_name = ("__Host-" if self._production else "") + "starter_crm_session"
        self._key = hashlib.sha256(
            ("starter-crm-session|" + (config.site_id or "") + "|" + (config.passcode or "")).encode("utf-8")
        ).digest()
        self._owner_id = config.starter_user_id or str(uuid.uuid5(uuid.UUID(config.site_id), "passcode|owner"))

    def _sign(self, payload: str) -> str:
        return _b64url(hmac.new(self._key, payload.encode("ascii"), hashlib.sha256).digest())

    def _cookie_header(self, value: str, max_age: int) -> str:
        parts = [self._cookie_name + "=" + value, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=" + str(max_age)]
        if self._production:
            parts.append("Secure")
        return "; ".join(parts)

    def authenticate(self, request) -> dict | None:
        """Reads and verifies the session cookie.

        Args:
            request: The Flask request.

        Returns:
            ``{"id": owner}``, or None for no cookie or a bad one.
        """
        raw = _read_cookie(request.headers.get("cookie"), self._cookie_name)
        dot = raw.find(".") if raw else -1
        if raw is None or dot < 1:
            return None
        payload = raw[:dot]
        try:
            mac = _unb64url(raw[dot + 1 :])
            expected = _unb64url(self._sign(payload))
            if not hmac.compare_digest(mac, expected):
                return None
            claims = json.loads(_unb64url(payload).decode("utf-8"))
        except (binascii.Error, ValueError, UnicodeError):
            return None
        now = int(time.time())
        valid = (
            isinstance(claims, dict)
            and claims.get("v") == COOKIE_VERSION
            and isinstance(claims.get("sub"), str)
            and 0 < len(claims["sub"]) <= 200
            and isinstance(claims.get("exp"), int)
            and not isinstance(claims.get("exp"), bool)
            and claims["exp"] > now
        )
        return {"id": claims["sub"]} if valid else None

    def _guard(self) -> None:
        """The checks every cookie-changing POST here shares: a trusted origin, then JSON."""
        check_origin(self._config)
        if not JSON_TYPE.match(request.headers.get("content-type") or ""):
            raise HttpError(415, "unsupported_media_type", "Send this request as application/json.")

    def routes(self) -> list[dict]:
        """The sign-in and sign-out routes.

        Returns:
            ``{"method", "path", "handler"}`` entries; each handler is a Flask view.
        """

        def sign_in():
            self._guard()
            g.limit("passcode", g.client_ip, SIGN_IN_LIMIT)
            body = read_json_body()
            given = body.get("passcode") if isinstance(body, dict) else None
            given = given if isinstance(given, str) else ""
            if not given or not _constant_time_equal(given, self._config.passcode or ""):
                raise HttpError(401, "invalid_passcode", "That passcode is not right.")
            issued = int(time.time())
            payload = _b64url(
                json.dumps(
                    {"v": COOKIE_VERSION, "sub": self._owner_id, "iat": issued, "exp": issued + SESSION_SECONDS},
                    separators=(",", ":"),
                ).encode("utf-8")
            )
            response = jsonify({"signed_in": True})
            response.headers["Cache-Control"] = "no-store"
            response.headers.add(
                "Set-Cookie", self._cookie_header(payload + "." + self._sign(payload), SESSION_SECONDS)
            )
            return response

        def sign_out():
            self._guard()
            response = jsonify({"signed_in": False})
            response.headers["Cache-Control"] = "no-store"
            response.headers.add("Set-Cookie", self._cookie_header("", 0))
            return response

        return [
            {"method": "POST", "path": "/api/auth/passcode", "handler": sign_in},
            {"method": "POST", "path": "/api/auth/signout", "handler": sign_out},
        ]


def create(ctx) -> PasscodeIdentity:
    """Creates the identity.

    Args:
        ctx: The provider context.

    Returns:
        The instance: ``authenticate``, ``routes``, plus ``cookie_auth`` so the app adds CSRF checks.
    """
    return PasscodeIdentity(ctx.config)
