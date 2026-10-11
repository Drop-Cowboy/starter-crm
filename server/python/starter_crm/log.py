"""A console logger that scrubs secrets and tokens from every line.

So a stray log of a request, a header or an error can never leak them.
"""

from __future__ import annotations

import json
import logging
import re
import sys
import traceback
from collections.abc import Iterable
from typing import IO, Any

# Anything shaped like a JWT, which is what a site token is.
JWT = re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*")
# A bearer credential, such as a login-mode access token, JWT-shaped or not.
BEARER = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]+=*", re.IGNORECASE)


def redact(text: str, secrets: Iterable[str]) -> str:
    """Replace every secret, bearer credential and JWT-shaped string in ``text``."""
    out = str(text)
    for secret in secrets:
        if secret and len(secret) >= 4:
            out = out.replace(secret, "[redacted]")
    return JWT.sub("[redacted-token]", BEARER.sub("Bearer [redacted]", out))


class Logger:
    """``info`` goes to stdout, ``warn`` and ``error`` to stderr, like Node's console.

    Each call joins its arguments with spaces, the way ``console.log`` does.
    """

    def __init__(self, secrets: Iterable[str], stdout: IO[str] | None = None, stderr: IO[str] | None = None):
        self._secrets = list(secrets)
        self._stdout = stdout
        self._stderr = stderr

    def info(self, *parts: Any) -> None:
        self._write(self._stdout or sys.stdout, parts)

    def warn(self, *parts: Any) -> None:
        self._write(self._stderr or sys.stderr, parts)

    def error(self, *parts: Any) -> None:
        self._write(self._stderr or sys.stderr, parts)

    def _write(self, stream: IO[str], parts: tuple) -> None:
        line = " ".join(_stringify(part) for part in parts)
        print(redact(line, self._secrets), file=stream, flush=True)


class RedactingFilter(logging.Filter):
    """Applies ``redact`` to records from libraries that use ``logging``.

    ``__main__`` attaches it to Werkzeug's logger, the only one the server
    leaves switched on.
    """

    def __init__(self, secrets: Iterable[str]):
        super().__init__()
        self._secrets = list(secrets)

    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact(record.getMessage(), self._secrets)
        record.args = ()
        if record.exc_info:
            record.exc_text = redact("".join(traceback.format_exception(*record.exc_info)), self._secrets)
        return True


def _stringify(value: Any) -> str:
    if isinstance(value, BaseException):
        return "".join(traceback.format_exception(type(value), value, value.__traceback__)).rstrip()
    if isinstance(value, str):
        return value
    return json.dumps(value, default=str)
