"""``GET /__dev/session``: development only (DC_AUTH_MODE=mcp-session).

An AI agent minted a site token with the Drop Cowboy MCP and wrote it to
``.dropcowboy/session.json``. This hands it to the browser on the same
machine and to nobody else.
"""

from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Callable

from flask import jsonify, request

from .config import Config
from .errors import HttpError
from .json_utils import is_number, parse_object

LOOPBACK_HOSTNAMES = {"localhost", "127.0.0.1", "[::1]"}
LOOPBACK_IPV4 = re.compile(r"127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}")


def session_file_path(config: Config) -> Path:
    return config.root / ".dropcowboy" / "session.json"


def dev_session_view(config: Config) -> Callable:
    def get_dev_session():
        # The TCP peer, never X-Forwarded-For: any client can send that header.
        # Flask's remote_addr is the socket address unless you add ProxyFix.
        if not is_loopback_address(request.remote_addr):
            raise HttpError(403, "loopback_only", "The dev session is only served to this machine.")
        # A hostile page can point its own hostname at 127.0.0.1 (DNS
        # rebinding). Its requests still carry that hostname in Host.
        if not is_loopback_host(request.headers.get("Host")):
            raise HttpError(403, "loopback_only", "Open the app at http://localhost or http://127.0.0.1.")

        session = read_session(session_file_path(config), time.time() * 1000)
        site_id = session.get("site_id")
        response = jsonify(
            {
                "token": session["token"],
                "expires_at": session["expires_at"],
                "site_id": site_id if isinstance(site_id, str) and site_id else config.site_id,
            }
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    return get_dev_session


def read_session(file: Path, now_ms: float) -> dict:
    """Reads and checks the session file. Raises ``HttpError`` when it is unusable."""
    try:
        text = file.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        raise HttpError(
            404,
            "session_not_found",
            "No .dropcowboy/session.json yet. Ask your AI agent to mint a site token with the Drop Cowboy MCP "
            "(mint_embed_token) and write { token, expires_at, site_id } to .dropcowboy/session.json "
            "in the starter folder.",
        ) from None

    session = parse_object(text)
    if session is None or not isinstance(session.get("token"), str) or session["token"] == "":
        raise HttpError(500, "session_invalid", '.dropcowboy/session.json must be JSON with a string "token".')
    expires_at = session.get("expires_at")
    # Below 1e12 it is almost certainly seconds, not milliseconds.
    if not is_number(expires_at) or expires_at < 1e12:
        raise HttpError(500, "session_invalid", '.dropcowboy/session.json "expires_at" must be epoch milliseconds.')
    if expires_at <= now_ms:
        raise HttpError(
            410, "session_expired", "The dev session token has expired. Ask your AI agent to mint a new one."
        )
    return session


def is_loopback_address(address: str | None) -> bool:
    """True for 127.0.0.0/8, ::1 and IPv4-mapped ::ffff:127.x.x.x."""
    if not isinstance(address, str):
        return False
    ip = address[len("::ffff:") :] if address.startswith("::ffff:") else address
    return ip == "::1" or LOOPBACK_IPV4.fullmatch(ip) is not None


def is_loopback_host(host_header: str | None) -> bool:
    """True when the Host header names this machine: localhost, 127.0.0.1 or [::1], any port."""
    if not isinstance(host_header, str) or host_header == "":
        return False
    host = host_header.lower()
    hostname = host[: host.find("]") + 1] if host.startswith("[") else host.split(":")[0]
    return hostname in LOOPBACK_HOSTNAMES
