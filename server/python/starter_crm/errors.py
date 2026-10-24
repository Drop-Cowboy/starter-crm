"""Every error leaves this server as ``{"error": {"code", "message", "request_id"}}``.

The request id is the one echoed in ``X-Request-Id``, so a user can quote it
and you can find the matching log lines.

See "Error envelope" in ../CONTRACT.md.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from flask import Flask, g, has_request_context, jsonify, request
from werkzeug.exceptions import HTTPException, MethodNotAllowed, NotFound, RequestEntityTooLarge

from .log import Logger

STATUS_CODES = {
    400: "bad-request",
    402: "payment-required",
    403: "forbidden",
    404: "not-found",
    409: "conflict",
    422: "unprocessable-entity",
    429: "too-many-requests",
}

MAX_MESSAGE_LENGTH = 300


class HttpError(Exception):
    """Raise this from any route to answer with the error envelope."""

    def __init__(self, status: int, code: str, message: str, headers: Mapping[str, str] | None = None):
        """Records the answer to send.

        Args:
            status: HTTP status code.
            code: Stable machine-readable error code from CONTRACT.md.
            message: Plain-language text safe to show a user; never a secret.
            headers: Extra response headers, such as ``Retry-After``.
        """
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.headers = dict(headers or {})


def error_response(status: int, code: str, message: str, headers: Mapping[str, str] | None = None):
    """Builds the ``{ error: { code, message, request_id } }`` envelope.

    Args:
        status: HTTP status code.
        code: Stable machine-readable error code.
        message: Plain-language text safe to show a user.
        headers: Extra response headers.

    Returns:
        A Flask response with the envelope as JSON.
    """
    request_id = g.get("request_id") if has_request_context() else None
    response = jsonify({"error": {"code": code, "message": message, "request_id": request_id}})
    response.status_code = status
    for name, value in (headers or {}).items():
        response.headers[name] = value
    return response


def from_upstream(status: int, body: Any, headers: Mapping[str, str] | None) -> HttpError:
    """Maps a Drop Cowboy error answer to the envelope.

    Only the code, a short message and Retry-After are kept. The raw upstream
    body is never echoed back.
    """
    if status == 401:
        return HttpError(
            502,
            "upstream_auth_failed",
            "Drop Cowboy rejected this server's API key. Check DROPCOWBOY_API_KEY and DROPCOWBOY_API_SECRET.",
        )
    if status < 400 or status >= 500:
        return HttpError(502, "upstream_error", "Drop Cowboy could not complete the request. Try again shortly.")

    extra = {}
    retry_after = headers.get("Retry-After") if headers is not None else None
    if status == 429 and retry_after:
        extra["Retry-After"] = retry_after
    return HttpError(status, upstream_code(status, body), _upstream_message(status, body), extra)


def upstream_code(status: int, body: Any) -> str:
    """The first non-empty string of detail.code, details.code, code, error, the type's last segment."""
    b = body if isinstance(body, dict) else {}
    detail = b.get("detail")
    details = b.get("details")
    kind = b.get("type")
    candidates = [
        detail.get("code") if isinstance(detail, dict) else None,
        details.get("code") if isinstance(details, dict) else None,
        b.get("code"),
        b.get("error"),
        kind.split("/")[-1] if isinstance(kind, str) else None,
    ]
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return STATUS_CODES.get(status, "bad-request")


def register_error_handlers(app: Flask, log: Logger) -> None:
    """Turns every exception a route can raise into the envelope.

    Args:
        app: The Flask app.
        log: The root logger; a request's own logger (``g.log``, tagged with its id) is preferred.
    """

    @app.errorhandler(HttpError)
    def handle_http_error(err: HttpError):
        return error_response(err.status, err.code, err.message, err.headers)

    @app.errorhandler(HTTPException)
    def handle_werkzeug_error(err: HTTPException):
        # A known path with the wrong method is "no such route" too, as in Node.
        if isinstance(err, (NotFound, MethodNotAllowed)):
            return not_found_response()
        if isinstance(err, RequestEntityTooLarge):
            return error_response(413, "payload_too_large", "Request body is larger than 1 MB.")
        code = (err.name or "http_error").lower().replace(" ", "_")
        return error_response(err.code or 500, code, err.description or err.name or "Request failed.")

    @app.errorhandler(Exception)
    def handle_unexpected(err: Exception):
        request_log = g.get("log") or log
        request_log.error("Unhandled error on", request.method, request.path + ":", err)
        hooks = app.config.get("STARTER_CRM_HOOKS")
        if hooks is not None:
            hooks.on_error(
                {
                    "request_id": g.get("request_id"),
                    "method": request.method,
                    "path": request.path,
                    "message": str(err) or err.__class__.__name__,
                }
            )
        return error_response(500, "internal_error", "Something went wrong on this server.")


def not_found_response():
    """Builds the 404 ``not_found`` envelope for the current request.

    Returns:
        A Flask response naming the method and path that matched nothing.
    """
    return error_response(404, "not_found", "No route matches " + request.method + " " + request.path + ".")


def _upstream_message(status: int, body: Any) -> str:
    b = body if isinstance(body, dict) else {}
    for candidate in (b.get("detail"), b.get("message"), b.get("title")):
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()[:MAX_MESSAGE_LENGTH]
    return "Drop Cowboy refused the request (" + str(status) + ")."
