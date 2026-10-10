"""Shared test helpers. No test talks to the real Drop Cowboy API or needs credentials."""

from __future__ import annotations

import hashlib
import hmac
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from starter_crm.app import create_app
from starter_crm.config import load_config
from starter_crm.events import EventStore
from starter_crm.log import Logger

SITE_ID = "3f8a2c1e-9b4d-4e7a-8c2f-1d5e6a7b8c9d"
USER_ID = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
API_KEY = "unit-test-key-0001"
API_SECRET = "unit-test-secret-0002"
WEBHOOK_SECRET = "unit-test-webhook-secret-0003"


class SilentStream:
    def write(self, text):
        pass

    def flush(self):
        pass


def make_config(**env):
    """A valid server-mode config. Keyword arguments override variables; "" unsets one."""
    values = {
        "DC_AUTH_MODE": "server",
        "DROPCOWBOY_API_KEY": API_KEY,
        "DROPCOWBOY_API_SECRET": API_SECRET,
        "DROPCOWBOY_SITE_ID": SITE_ID,
        "DROPCOWBOY_WEBHOOK_SECRET": WEBHOOK_SECRET,
        "DROPCOWBOY_API_BASE": "https://api.example.test",
        "STARTER_CRM_USER_ID": USER_ID,
        "STARTER_CRM_ROOT": "/nonexistent-starter-root",
    }
    values.update(env)
    config, problems = load_config(values)
    if problems:
        raise AssertionError("; ".join(problems))
    return config


def make_client(config, store=None):
    silent = Logger([], stdout=SilentStream(), stderr=SilentStream())
    return create_app(config, log=silent, store=store or EventStore()).test_client()


def sign(raw_body: str, secret: str, timestamp: str) -> str:
    message = (timestamp + "." + raw_body).encode("utf-8")
    return "sha256=" + hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def json_answer(status, body, headers=None):
    return status, json.dumps(body), dict(headers or {}, **{"Content-Type": "application/json"})


class FakeUpstream:
    """A stand-in Drop Cowboy API on a random loopback port.

    Set ``respond`` to a function ``call -> (status, body text, headers)``.
    Every request is recorded in ``calls`` as a dict with method, path,
    lowercased headers and the parsed JSON body.
    """

    def __init__(self):
        self.calls = []
        self.respond = lambda call: json_answer(200, {"data": {}})
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self._answer()

            def do_POST(self):
                self._answer()

            def _answer(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length).decode("utf-8") if length else ""
                call = {
                    "method": self.command,
                    "path": self.path,
                    "headers": {name.lower(): value for name, value in self.headers.items()},
                    "body": json.loads(raw) if raw else None,
                }
                upstream.calls.append(call)
                status, text, headers = upstream.respond(call)
                payload = text.encode("utf-8")
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, format, *args):
                pass

        class QuietServer(ThreadingHTTPServer):
            def handle_error(self, request, client_address):
                pass  # A client that timed out and hung up is expected here.

        self.server = QuietServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:" + str(self.server.server_port)
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
