"""Response security headers, CORS and the CSRF origin check.

Where it sits: ``app.py`` calls ``apply_security_headers`` and ``apply_cors``
on every response and ``preflight`` for OPTIONS requests; the identity
providers call ``check_origin`` before a cookie-authenticated POST.

CONTRACT.md: "Response headers", "CORS" and "Identity routes" (CSRF).
What a customer changes: ``DC_CSP`` and ``DC_CORS_ORIGINS``, not this file.
"""

from __future__ import annotations

from flask import Response, request

from .config import Config
from .errors import HttpError, error_response

# One year, no includeSubDomains: this server does not know what else lives on the domain.
HSTS = "max-age=31536000"
PREFLIGHT_MAX_AGE = "600"


def content_security_policy(config: Config) -> str:
    """The Content-Security-Policy. Only public origins appear.

    Those are Drop Cowboy's Building Blocks and API hosts, plus the sign-in host in ``login`` mode.

    Args:
        config: The loaded config.

    Returns:
        The policy.
    """
    blocks = "https://webforms.dropcowboy.com"
    api = "https://app-api-v2.dropcowboy.com"
    connect = ["'self'", api, "wss://app-api-v2.dropcowboy.com", "https://api-v2.dropcowboy.com"]
    frames = [blocks]
    if config.mode == "login":
        login = "https://" + config.auth0.domain
        connect.append(login)
        frames.append(login)
    return "; ".join(
        [
            "default-src 'self'",
            "script-src 'self' " + blocks,
            # Inline styles: the Building Blocks set style attributes while they render.
            "style-src 'self' 'unsafe-inline' " + blocks,
            "img-src 'self' data: blob: " + blocks,
            "font-src 'self' data: " + blocks,
            "connect-src " + " ".join(connect),
            "frame-src " + " ".join(frames),
            "media-src 'self' blob:",
            "worker-src 'self' blob:",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ]
    )


def apply_security_headers(response, config: Config) -> None:
    """Sets the fixed security headers on a response.

    Args:
        response: The Flask response to mark.
        config: The loaded config.
    """
    headers = response.headers
    headers["X-Content-Type-Options"] = "nosniff"
    headers["Referrer-Policy"] = "no-referrer"
    headers["Cross-Origin-Opener-Policy"] = "same-origin"
    # The dialer needs the microphone; nothing here needs the camera or location.
    headers["Permissions-Policy"] = "microphone=(self), camera=(), geolocation=()"
    # Browsers ignore frame-ancestors in a report-only policy, so say it twice.
    headers["X-Frame-Options"] = "DENY"
    if config.csp == "enforce":
        headers["Content-Security-Policy"] = content_security_policy(config)
    if config.csp == "report-only":
        headers["Content-Security-Policy-Report-Only"] = content_security_policy(config)
    if config.env == "production":
        headers["Strict-Transport-Security"] = HSTS


def apply_cors(response, config: Config) -> None:
    """Adds CORS headers when the request's origin is on the allowlist.

    Args:
        response: The Flask response to mark.
        config: The loaded config.
    """
    origin = request.headers.get("Origin")
    if not origin or origin not in config.cors_origins:
        return
    response.headers["Access-Control-Allow-Origin"] = origin
    response.headers.add("Vary", "Origin")
    response.headers["Access-Control-Expose-Headers"] = "X-Request-Id, Retry-After"


def preflight(config: Config):
    """Answers a CORS preflight.

    Args:
        config: The loaded config.

    Returns:
        204 for an allowed origin, 403 ``cors_rejected`` for any other, or None when this
        is not a preflight or CORS is off (the caller answers 404).
    """
    if not config.cors_origins or not request.headers.get("Access-Control-Request-Method"):
        return None
    origin = request.headers.get("Origin")
    if not origin or origin not in config.cors_origins:
        return error_response(
            403, "cors_rejected", "This origin is not allowed to call the API. Add it to DC_CORS_ORIGINS."
        )
    response = Response(status=204)
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, Last-Event-ID, X-Request-Id"
    response.headers["Access-Control-Max-Age"] = PREFLIGHT_MAX_AGE
    return response


def _trusted_origins(config: Config) -> list[str]:
    """The origins a cookie-authenticated request may come from: this server's own, plus ``DC_CORS_ORIGINS``."""
    if config.public_url:
        own = config.public_url
    else:
        scheme = request.scheme
        host = request.host
        # Only believe the proxy's headers when told how many proxies to trust.
        if config.trust_proxy > 0:
            forwarded_proto = (request.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip()
            forwarded_host = (request.headers.get("X-Forwarded-Host") or "").split(",")[0].strip()
            scheme = forwarded_proto or scheme
            host = forwarded_host or host
        own = scheme + "://" + host
    return [own, *config.cors_origins]


def check_origin(config: Config) -> None:
    """The CSRF check for a state-changing request that authenticates with a cookie.

    A browser attaches cookies to cross-site requests, so a hostile page could
    make one on the user's behalf. The browser always says where such a request
    came from, in ``Origin`` or ``Sec-Fetch-Site``, and a cookie-less client (curl,
    a server) is not at risk, so a request with neither header is refused too.

    Args:
        config: The loaded config.

    Raises:
        HttpError: 403 ``csrf_rejected``.
    """
    rejection = HttpError(
        403,
        "csrf_rejected",
        "This request came from an origin this server does not trust. Open the app at its own address.",
    )
    origin = request.headers.get("Origin")
    if origin is not None:
        if origin not in _trusted_origins(config):
            raise rejection
        return
    site = request.headers.get("Sec-Fetch-Site")
    if site in ("same-origin", "none"):
        return
    raise rejection
