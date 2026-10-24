"""The ``oidc`` identity: verifies a bearer JWT from an OpenID Connect issuer.

Where it sits: for apps whose users already sign in somewhere else (Auth0,
Clerk, Supabase, Firebase, Okta, Keycloak). The browser sends
``Authorization: Bearer <JWT>`` and this verifies the signature against the
issuer's published keys, then maps the token to a user. Nothing is stored.

What is checked, and why:

- Only RS256 and ES256. Refusing everything else, ``none`` and the HS* family
  included, is what stops algorithm-confusion attacks.
- ``iss`` and ``aud`` must match exactly, and ``exp`` must exist, with 60
  seconds of clock skew.
- Keys come from ``DC_OIDC_JWKS_URL``, or from the issuer's discovery document.
  They are cached, and an unknown key id triggers a refetch at most every 2
  seconds, so made-up key ids cannot make this server hammer the issuer.

The user id is the token's ``sub`` when that is a UUID, else
``UUIDv5(DROPCOWBOY_SITE_ID, issuer + "|" + sub)``: Drop Cowboy needs a UUID, and
v5 is stateless and the same on every server.

CONTRACT.md: "The ``oidc`` identity".
Env: DC_OIDC_ISSUER (https; plain http only for a loopback host),
DC_OIDC_AUDIENCE, DC_OIDC_JWKS_URL (optional), DROPCOWBOY_SITE_ID.
What a customer changes: nothing; see CUSTOMIZE.md for per-vendor settings.
"""

from __future__ import annotations

import re
import threading
import time
import uuid
from urllib.parse import urlparse

from ...errors import HttpError
from ...problems import BootProblem, problem
from ...upstream import fetch_json

name = "oidc"
config_keys = ["DC_OIDC_ISSUER", "DC_OIDC_AUDIENCE", "DC_OIDC_JWKS_URL"]

# Clock skew accepted on ``exp`` and ``nbf``: 60 seconds covers ordinary drift between servers.
CLOCK_TOLERANCE_SECONDS = 60

# Minimum gap between key-set refetches triggered by an unknown key id.
JWKS_COOLDOWN_SECONDS = 2.0

# How long fetched keys are trusted before a refetch even for a known key id: ten minutes.
JWKS_MAX_AGE_SECONDS = 10 * 60.0

# How long to wait for the issuer before reporting it unavailable.
ISSUER_TIMEOUT_SECONDS = 5.0

ALGORITHMS = ("RS256", "ES256")
LOOPBACK = ("localhost", "127.0.0.1", "::1")
BEARER = re.compile(r"Bearer +([^ ]+) *", re.IGNORECASE)
UUID_PATTERN = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)
HTTP_URL = re.compile(r"https?://[^/]+")


def validate(env) -> list[BootProblem]:
    """Checks the ``DC_OIDC_*`` settings.

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    issuer = (env.get("DC_OIDC_ISSUER") or "").strip()
    audience = (env.get("DC_OIDC_AUDIENCE") or "").strip()
    jwks = (env.get("DC_OIDC_JWKS_URL") or "").strip()
    problems: list[BootProblem] = []

    if not issuer:
        problems.append(
            problem(
                "missing_oidc_issuer",
                "DC_IDENTITY=oidc needs DC_OIDC_ISSUER.",
                "Set DC_OIDC_ISSUER to your identity provider's issuer URL, such as https://example.us.auth0.com/.",
            )
        )
    else:
        parsed = urlparse(issuer)
        secure = parsed.scheme == "https" or (parsed.scheme == "http" and (parsed.hostname or "") in LOOPBACK)
        if not secure or not parsed.netloc:
            problems.append(
                problem(
                    "invalid_oidc_issuer",
                    "DC_OIDC_ISSUER must be an https URL (plain http is only allowed for localhost).",
                    "Use the https issuer URL from your identity provider.",
                )
            )
    if not audience:
        problems.append(
            problem(
                "missing_oidc_audience",
                "DC_IDENTITY=oidc needs DC_OIDC_AUDIENCE.",
                "Set DC_OIDC_AUDIENCE to the audience (API identifier or client id) your tokens are issued for.",
            )
        )
    if jwks and not HTTP_URL.match(jwks):
        problems.append(
            problem(
                "invalid_oidc_jwks_url",
                "DC_OIDC_JWKS_URL must be an http(s) URL.",
                "Set DC_OIDC_JWKS_URL to the issuer's key set URL, or leave it empty to use discovery.",
            )
        )
    return problems


class _KeySet:
    """The issuer's public keys, cached, with a cooldown on refetching.

    PyJWT's own key client refetches on every unknown key id, which a caller
    could abuse; this one refetches at most once per cooldown and keeps serving
    cached keys while the issuer is down.
    """

    def __init__(self, issuer: str, jwks_url: str | None):
        """Creates an empty key set.

        Args:
            issuer: The issuer URL, used for discovery.
            jwks_url: An explicit key set URL, or None to discover it.
        """
        self._issuer = issuer
        self._jwks_url = jwks_url
        self._keys: dict[str, object] = {}
        self._anonymous: list[object] = []
        self._fetched_at: float | None = None
        self._lock = threading.Lock()

    def _discover(self) -> str:
        """Finds the key set URL from the discovery document.

        Raises:
            HttpError: 503 ``identity_unavailable`` when discovery fails.
        """
        document = fetch_json(self._issuer.rstrip("/") + "/.well-known/openid-configuration", ISSUER_TIMEOUT_SECONDS)
        uri = document.get("jwks_uri") if isinstance(document, dict) else None
        if not isinstance(uri, str) or not uri:
            raise _unavailable()
        self._jwks_url = uri
        return uri

    def _fetch(self) -> None:
        """Replaces the cached keys with the issuer's current ones.

        Raises:
            HttpError: 503 ``identity_unavailable`` when the issuer cannot be reached.
        """
        import jwt  # noqa: PLC0415 - imported only when oidc is selected

        url = self._jwks_url or self._discover()
        document = fetch_json(url, ISSUER_TIMEOUT_SECONDS)
        entries = document.get("keys") if isinstance(document, dict) else None
        if not isinstance(entries, list):
            raise _unavailable()
        keys: dict[str, object] = {}
        anonymous: list[object] = []
        for entry in entries:
            if not isinstance(entry, dict) or entry.get("use") not in (None, "sig"):
                continue
            try:
                key = jwt.PyJWK.from_dict(entry).key
            except (jwt.PyJWKError, ValueError, TypeError):
                continue
            if isinstance(entry.get("kid"), str):
                keys[entry["kid"]] = key
            else:
                anonymous.append(key)
        self._keys, self._anonymous, self._fetched_at = keys, anonymous, time.monotonic()

    def key_for(self, kid: str | None):
        """Finds the verification key for a token's key id.

        Args:
            kid: The ``kid`` from the token header, or None.

        Returns:
            The key, or None when the issuer has no such key (a token problem).

        Raises:
            HttpError: 503 ``identity_unavailable`` when a refetch was needed and failed.
        """
        with self._lock:
            now = time.monotonic()
            known = kid in self._keys if kid is not None else len(self._anonymous) == 1
            stale = self._fetched_at is None or now - self._fetched_at >= JWKS_MAX_AGE_SECONDS
            cooled = self._fetched_at is None or now - self._fetched_at >= JWKS_COOLDOWN_SECONDS
            if cooled and (not known or stale):
                try:
                    self._fetch()
                except HttpError:
                    # A stale but known key still verifies; an unknown one cannot be checked.
                    if not known:
                        raise
            if kid is not None:
                return self._keys.get(kid)
            return self._anonymous[0] if len(self._anonymous) == 1 else None


def _unavailable() -> HttpError:
    return HttpError(503, "identity_unavailable", "The sign-in provider could not be reached. Try again shortly.")


def _challenge(error: str | None = None) -> dict:
    return {"www-authenticate": "Bearer" + (' error="' + error + '"' if error else "")}


class OidcIdentity:
    """Verifies bearer tokens against the issuer's keys."""

    challenge = "Bearer"

    def __init__(self, config):
        """Creates the identity from the config.

        Args:
            config: The loaded config (``oidc`` settings and ``site_id``).
        """
        self._issuer = config.oidc.issuer
        self._audience = config.oidc.audience
        self._site_id = config.site_id
        self._keys = _KeySet(self._issuer, config.oidc.jwks_url)

    def authenticate(self, request) -> dict | None:
        """Verifies the bearer token, if there is one.

        Args:
            request: The Flask request.

        Returns:
            ``{"id", "email"?, "name"?}``, or None when no token was sent.

        Raises:
            HttpError: 401 ``invalid_token`` for a token that does not verify, or
                503 ``identity_unavailable`` when the issuer cannot be reached.
        """
        import jwt  # noqa: PLC0415 - imported only when oidc is selected

        match = BEARER.fullmatch(request.headers.get("authorization") or "")
        if match is None:
            return None
        token = match.group(1)
        invalid = HttpError(
            401, "invalid_token", "The sign-in token is not valid. Sign in again.", _challenge("invalid_token")
        )
        try:
            header = jwt.get_unverified_header(token)
        except jwt.InvalidTokenError:
            raise invalid from None
        if header.get("alg") not in ALGORITHMS:
            raise invalid
        kid = header.get("kid")
        key = self._keys.key_for(kid if isinstance(kid, str) else None)
        if key is None:
            raise invalid
        try:
            claims = jwt.decode(
                token,
                key,
                algorithms=list(ALGORITHMS),
                audience=self._audience,
                issuer=self._issuer,
                leeway=CLOCK_TOLERANCE_SECONDS,
                options={"require": ["exp"]},
            )
        except (jwt.InvalidTokenError, ValueError, TypeError):
            raise invalid from None
        subject = claims.get("sub")
        if not isinstance(subject, str) or subject == "":
            raise HttpError(401, "invalid_token", "The sign-in token has no subject.", _challenge("invalid_token"))
        if UUID_PATTERN.fullmatch(subject):
            user = {"id": subject.lower()}
        else:
            user = {"id": str(uuid.uuid5(uuid.UUID(self._site_id), self._issuer + "|" + subject))}
        if isinstance(claims.get("email"), str):
            user["email"] = claims["email"]
        if isinstance(claims.get("name"), str):
            user["name"] = claims["name"]
        return user


def create(ctx) -> OidcIdentity:
    """Creates the identity. Fails clearly when PyJWT is not installed.

    Args:
        ctx: The provider context.

    Returns:
        The instance.
    """
    try:
        import jwt  # noqa: F401, PLC0415 - checked here so a missing package is a boot problem, not a 500
    except ImportError as err:
        raise RuntimeError("DC_IDENTITY=oidc needs the PyJWT package: pip install 'PyJWT[crypto]'.") from err
    return OidcIdentity(ctx.config)
