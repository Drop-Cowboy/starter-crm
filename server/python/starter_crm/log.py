"""The redacting logger: every record passes through ``redact`` before a sink sees it.

Where it sits: ``bootstrap`` builds one ``Logger`` from the config and a log
sink (the ``console`` provider, or your own), and each request gets a child
logger tagged with its request id. Redaction happens here, ahead of the sink,
so it applies to custom sinks too, and a stray log of a request, a header or an
error can never leak a secret, a token, a phone number or an email address.

CONTRACT.md: "Logging" (secrets and tokens never appear in output).
What a customer changes: nothing. Keep using it for every log line.
"""

from __future__ import annotations

import json
import logging
import re
import sys
import traceback
from collections.abc import Callable, Iterable
from datetime import UTC, datetime
from typing import IO, Any

# Anything shaped like a JWT, which is what a site token is.
JWT = re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*")
# A bearer credential, such as a login-mode access token, JWT-shaped or not.
BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]+=*", re.IGNORECASE)
# An email address. Contacts' emails must not end up in log storage.
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
# A phone number: 10 digits as 3-3-4 with common separators and an optional
# parenthesised area code, with an optional country code in front. A country
# code needs a leading "+" or a separator after it, and the match must not start
# inside a longer word or run into more digits, so a 13-digit epoch-millisecond
# timestamp is left alone. [0-9], not \d, which also matches non-ASCII digits in
# Python.
PHONE = re.compile(
    r"(?<!\w)(?:\+[0-9]{1,3}[\s.-]?|[0-9]{1,3}[\s.-])?(?:\([0-9]{3}\)|[0-9]{3})[\s.-]?[0-9]{3}[\s.-]?[0-9]{4}(?![0-9])"
)
# A UUID, matched in the same pass so it is kept whole: a last segment that
# starts with 10 digits, as about one in a hundred do, otherwise looks like a
# phone number, and a request id must survive to be searchable.
UUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")
UUID_OR_PHONE = re.compile("(" + UUID.pattern + ")|" + PHONE.pattern, re.IGNORECASE)

# Shortest configured secret that is redacted: shorter strings would mangle
# ordinary words if someone chose a trivial secret.
MIN_SECRET_LENGTH = 4


def redact(text: str, secrets: Iterable[str]) -> str:
    """Replaces secrets, bearer credentials, JWTs, emails and phone numbers with markers.

    Args:
        text: The text to clean.
        secrets: Exact secret values to remove.

    Returns:
        The text with every match replaced.
    """
    out = str(text)
    for secret in secrets:
        if secret and len(secret) >= MIN_SECRET_LENGTH:
            out = out.replace(secret, "[redacted]")
    out = BEARER.sub("Bearer [redacted]", out)
    out = JWT.sub("[redacted-token]", out)
    out = EMAIL.sub("[redacted-email]", out)
    return UUID_OR_PHONE.sub(_keep_uuid, out)


def _keep_uuid(match: re.Match[str]) -> str:
    """Keeps a matched UUID and redacts a matched phone number."""
    return match.group(0) if match.group(1) else "[redacted-phone]"


def redact_value(value: Any, secrets: list[str], depth: int = 0) -> Any:
    """Redacts every string inside a value, however deeply it is nested.

    Args:
        value: A log field.
        secrets: Exact secret values to remove.
        depth: Recursion guard against cycles.

    Returns:
        A copy with every string cleaned; non-strings that are not containers pass through.
    """
    if isinstance(value, str):
        return redact(value, secrets)
    if depth > 6:
        return "[truncated]"
    if isinstance(value, dict):
        return {str(key): redact_value(item, secrets, depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [redact_value(item, secrets, depth + 1) for item in value]
    if isinstance(value, BaseException):
        return redact(_stringify(value), secrets)
    return value


class ConsoleSink:
    """Writes a record to stdout (info) or stderr (warn, error), as pretty text or a JSON line.

    This is what the ``console`` log provider returns.
    """

    def __init__(self, fmt: str, stdout: IO[str] | None = None, stderr: IO[str] | None = None):
        """Creates the sink.

        Args:
            fmt: ``pretty`` (the message alone) or ``json`` (the whole record).
            stdout: Stream for info lines; defaults to ``sys.stdout`` at call time.
            stderr: Stream for warn and error lines; defaults likewise.
        """
        self._fmt = fmt
        self._stdout = stdout
        self._stderr = stderr

    def write(self, record: dict) -> None:
        """Prints one record.

        Args:
            record: The already-redacted record.
        """
        line = json.dumps(record, default=str) if self._fmt == "json" else record["message"]
        stream = (self._stderr or sys.stderr) if record["level"] in ("warn", "error") else (self._stdout or sys.stdout)
        print(line, file=stream, flush=True)


class Logger:
    """Builds redacted records and hands them to a sink.

    Each call joins its arguments with spaces, the way ``console.log`` does.
    ``info`` goes to stdout, ``warn`` and ``error`` to stderr when the sink is
    the console one.
    """

    def __init__(
        self,
        secrets: Iterable[str] | Callable[[], Iterable[str]],
        stdout: IO[str] | None = None,
        stderr: IO[str] | None = None,
        sink: Any = None,
        fmt: str = "pretty",
        bound: dict | None = None,
    ):
        """Creates a logger that redacts ``secrets`` from every record.

        Args:
            secrets: Values that must never be printed, or a function returning them. A
                function is called on every record, so secrets a provider loads later are covered.
            stdout: Stream for ``info`` when no ``sink`` is given; defaults to ``sys.stdout`` at call time.
            stderr: Stream for ``warn`` and ``error`` when no ``sink`` is given; defaults likewise.
            sink: Where records go: any object with ``write(record)``. Defaults to the console.
            fmt: ``pretty`` or ``json``, for the default console sink.
            bound: Fields added to every record (``child`` uses this).
        """
        self._secrets = secrets
        self._sink = sink if sink is not None else ConsoleSink(fmt, stdout, stderr)
        self._bound = dict(bound or {})

    def info(self, *parts: Any) -> None:
        """Logs at info level.

        Args:
            *parts: Values joined with spaces after redaction.
        """
        self._emit("info", " ".join(_stringify(part) for part in parts), {})

    def warn(self, *parts: Any) -> None:
        """Logs at warn level.

        Args:
            *parts: Values joined with spaces after redaction.
        """
        self._emit("warn", " ".join(_stringify(part) for part in parts), {})

    def error(self, *parts: Any) -> None:
        """Logs at error level.

        Args:
            *parts: Values joined with spaces after redaction.
        """
        self._emit("error", " ".join(_stringify(part) for part in parts), {})

    def access(self, fields: dict) -> None:
        """Logs one request line: ``method, path, status, duration_ms``.

        Args:
            fields: The request's fields; the path must not carry the query string.
        """
        line = f"{fields['method']} {fields['path']} {fields['status']} {fields['duration_ms']}ms"
        self._emit("info", line, fields)

    def child(self, fields: dict) -> Logger:
        """Returns a logger that adds ``fields`` to every record.

        Args:
            fields: Fields to add, such as ``{"request_id": "..."}``.

        Returns:
            A new logger sharing this one's sink and secrets.
        """
        merged = dict(self._bound)
        merged.update(fields)
        return Logger(self._secrets, sink=self._sink, bound=merged)

    def _emit(self, level: str, message: str, fields: dict) -> None:
        secrets = list(self._secrets() if callable(self._secrets) else self._secrets)
        record: dict[str, Any] = {
            "time": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": level,
            "message": redact(message, secrets),
        }
        for key, value in self._bound.items():
            record[key] = redact_value(value, secrets)
        for key, value in fields.items():
            record[key] = redact_value(value, secrets)
        # A sink that fails must not take a request down with it.
        try:
            self._sink.write(record)
        except Exception:  # noqa: BLE001 - nothing safe is left to report to
            return


class RedactingFilter(logging.Filter):
    """Applies ``redact`` to records from libraries that use ``logging``.

    ``__main__`` attaches it to Werkzeug's logger, the only one the server
    leaves switched on.
    """

    def __init__(self, secrets: Iterable[str] | Callable[[], Iterable[str]]):
        """Creates the filter.

        Args:
            secrets: Values that must never be printed, or a function returning them (called on every record).
        """
        super().__init__()
        self._secrets = secrets

    def filter(self, record: logging.LogRecord) -> bool:
        """Redacts the record in place.

        Args:
            record: The log record about to be emitted.

        Returns:
            Always True: redaction never drops a record.
        """
        secrets = list(self._secrets() if callable(self._secrets) else self._secrets)
        record.msg = redact(record.getMessage(), secrets)
        record.args = ()
        if record.exc_info:
            record.exc_text = redact("".join(traceback.format_exception(*record.exc_info)), secrets)
        return True


def _stringify(value: Any) -> str:
    if isinstance(value, BaseException):
        return "".join(traceback.format_exception(type(value), value, value.__traceback__)).rstrip()
    if isinstance(value, str):
        return value
    return json.dumps(value, default=str)
