"""The ``qstash`` webhook mode, and the refusal of ``vercel-queue`` and ``netlify-async`` in the Python server.

The checks that need no server always run: settings, the signature check, the publish request and the internal
route. The live suite runs against the QStash development server (tests/services.compose.yml) and skips, with a
reason, when it is not running. The Node server runs the same cases in ``server/node/test/qstash.test.js``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import threading
import time
import urllib.error
import uuid
from pathlib import Path

import pytest
from helpers import API_KEY, API_SECRET, SITE_ID, USER_ID, WEBHOOK_SECRET, SilentStream, make_config
from services import HAVE_QSTASH, QSTASH_DEV
from werkzeug.serving import make_server

from starter_crm.app import create_app
from starter_crm.bootstrap import bootstrap
from starter_crm.log import Logger
from starter_crm.providers import ProviderContext
from starter_crm.providers.webhooks import netlify_async, qstash, vercel_queue

STARTER_ROOT = Path(__file__).resolve().parents[3]
PUBLIC = "https://crm.example.test"
JOBS = PUBLIC + qstash.JOBS_PATH
GOOD = {
    "QSTASH_TOKEN": "t",
    "QSTASH_CURRENT_SIGNING_KEY": "current-key",
    "QSTASH_NEXT_SIGNING_KEY": "next-key",
    "DC_PUBLIC_URL": PUBLIC,
}


def b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def sign(data: bytes, url: str, key: str, **overrides) -> str:
    """A QStash-shaped signature: an HS256 token over the destination, the body hash and a short window."""
    now = int(time.time())
    claims = {
        "iss": "Upstash",
        "sub": url,
        "exp": now + 300,
        "nbf": now - 5,
        "iat": now,
        "jti": str(uuid.uuid4()),
        "body": b64(hashlib.sha256(data).digest()),
    }
    claims.update(overrides)
    head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = b64(json.dumps(claims).encode())
    mac = hmac.new(key.encode(), (head + "." + payload).encode(), hashlib.sha256).digest()
    return head + "." + payload + "." + b64(mac)


class TestSettings:
    def test_accepts_a_token_both_signing_keys_and_a_public_address(self):
        assert qstash.validate(GOOD) == []

    def test_names_every_missing_setting_once(self):
        found = qstash.validate({})
        assert [p.code for p in found] == [
            "missing_qstash_setting",
            "missing_qstash_setting",
            "missing_qstash_setting",
            "missing_qstash_public_url",
        ]
        text = " ".join(p.message for p in found)
        assert (
            text.index("QSTASH_TOKEN")
            < text.index("QSTASH_CURRENT_SIGNING_KEY")
            < text.index("QSTASH_NEXT_SIGNING_KEY")
        )

    def test_uses_the_project_domain_on_vercel_when_the_public_url_is_unset(self):
        env = {k: v for k, v in GOOD.items() if k != "DC_PUBLIC_URL"}
        env["VERCEL_PROJECT_PRODUCTION_URL"] = "crm.example.test"
        assert qstash.validate(env) == []
        assert qstash.public_origin(env) == PUBLIC
        assert qstash.public_origin({**GOOD, "DC_PUBLIC_URL": PUBLIC + "///"}) == PUBLIC

    def test_uses_the_netlify_site_address_only_on_netlify(self):
        env = {k: v for k, v in GOOD.items() if k != "DC_PUBLIC_URL"}
        assert qstash.public_origin({**env, "NETLIFY": "true", "URL": PUBLIC + "/"}) == PUBLIC
        assert qstash.public_origin({**env, "URL": PUBLIC}) == ""

    def test_requires_https_in_production_and_real_urls(self):
        assert qstash.validate({**GOOD, "DC_ENV": "production", "DC_PUBLIC_URL": "http://crm.example.test"})[
            0
        ].code == ("insecure_qstash_public_url")
        assert qstash.validate({**GOOD, "DC_PUBLIC_URL": "not a url"})[0].code == "invalid_qstash_public_url"
        assert qstash.validate({**GOOD, "QSTASH_URL": "nope"})[0].code == "invalid_qstash_url"


class TestVercelQueue:
    def test_refuses_and_names_the_modes_this_server_has(self):
        found = vercel_queue.validate({})
        assert [p.code for p in found] == ["vercel_queue_node_only"]
        for mode in ("qstash", "bullmq", "sqs", "store", "inline"):
            assert mode in found[0].fix

    def test_never_builds_a_dispatcher(self):
        with pytest.raises(RuntimeError):
            vercel_queue.create(None)


class TestNetlifyAsync:
    def test_refuses_and_names_the_modes_this_server_has(self):
        found = netlify_async.validate({"NETLIFY": "true", "AWL_API_KEY": "k"})
        assert [p.code for p in found] == ["netlify_async_node_only"]
        for mode in ("qstash", "bullmq", "sqs", "store", "inline"):
            assert mode in found[0].fix

    def test_never_builds_a_dispatcher(self):
        with pytest.raises(RuntimeError):
            netlify_async.create(None)


class TestVerifySignature:
    body = b'{"event_id":"a"}'

    def test_accepts_the_current_and_the_next_key(self):
        keys = ["current-key", "next-key"]
        assert qstash.verify_signature(sign(self.body, JOBS, "current-key"), self.body, JOBS, keys)
        assert qstash.verify_signature(sign(self.body, JOBS, "next-key"), self.body, JOBS, keys)

    def test_refuses_each_way_a_signature_can_be_wrong(self):
        keys = ["current-key", "next-key"]
        now = int(time.time())
        wrong = [
            sign(self.body, JOBS, "other-key"),
            sign(self.body, "https://elsewhere.example.test/internal/webhook-jobs", "current-key"),
            sign(b"{}", JOBS, "current-key"),
            sign(self.body, JOBS, "current-key", iss="someone"),
            sign(self.body, JOBS, "current-key", exp=now - 10),
            sign(self.body, JOBS, "current-key", nbf=now + 600),
            sign(self.body, JOBS, "current-key", body=None),
            "",
            "a.b",
            "not.a.jwt",
        ]
        for signature in wrong:
            assert not qstash.verify_signature(signature, self.body, JOBS, keys), signature

    def test_refuses_a_token_that_names_another_algorithm(self):
        good = sign(self.body, JOBS, "current-key")
        _, payload, mac = good.split(".")
        head = b64(json.dumps({"alg": "none"}).encode())
        assert not qstash.verify_signature(head + "." + payload + "." + mac, self.body, JOBS, ["current-key"])


class Opener:
    """A stand-in for ``urlopen`` that records the request and answers 200, or raises."""

    def __init__(self, fail=None):
        self.requests = []
        self.fail = fail

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        if self.fail:
            raise self.fail

        class Response:
            def read(self):
                return b"{}"

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        return Response()


class Warnings:
    def __init__(self):
        self.lines = []

    def warn(self, *args):
        self.lines.append(" ".join(str(a) for a in args))

    error = info = warn


class Processor:
    def __init__(self, fn):
        self.fn = fn

    def process(self, event_id):
        return self.fn(event_id)


def dispatcher_for(fn=lambda i: {"outcome": "processed"}, opener=None, env=None):
    config = make_config(DC_WEBHOOKS="qstash", DC_STORE="sqlite", DC_SQLITE_PATH=":memory:", **GOOD)
    ctx = ProviderContext(config, {**GOOD, **(env or {})}, Warnings(), STARTER_ROOT, None, Processor(fn))
    return qstash.create(ctx, opener=opener), config


class TestPublish:
    def test_publishes_only_the_event_id_and_the_site_with_the_backoff_as_its_retry_delay(self):
        opener = Opener()
        d, config = dispatcher_for(opener=opener)
        event_id = str(uuid.uuid4())
        assert d.dispatch(event_id) == {"outcome": "queued"}
        request = opener.requests[0]
        assert request.full_url == "https://qstash.upstash.io/v2/publish/" + JOBS
        assert json.loads(request.data) == {"event_id": event_id, "site_id": config.site_id}
        headers = {k.lower(): v for k, v in request.header_items()}
        assert headers["authorization"] == "Bearer t"
        assert headers["upstash-retry-delay"] == qstash.RETRY_DELAY

    def test_raises_when_qstash_refuses_or_cannot_be_reached(self):
        refused = urllib.error.HTTPError("u", 401, "no", {}, None)
        d, _ = dispatcher_for(opener=Opener(refused))
        with pytest.raises(RuntimeError, match="refused"):
            d.dispatch(str(uuid.uuid4()))
        d, _ = dispatcher_for(opener=Opener(urllib.error.URLError("down")))
        with pytest.raises(RuntimeError, match="reached"):
            d.dispatch(str(uuid.uuid4()))

    def test_sweep_publishes_each_event_again(self):
        opener = Opener()
        d, _ = dispatcher_for(opener=opener)
        d.sweep([str(uuid.uuid4()), str(uuid.uuid4())])
        assert len(opener.requests) == 2


def silent_client(d, config):
    from starter_crm.runtime import default_runtime  # noqa: PLC0415

    log = Logger([], stdout=SilentStream(), stderr=SilentStream())
    runtime = default_runtime(config, log)
    runtime.dispatcher = d
    return create_app(config, log=log, runtime=runtime).test_client(use_cookies=False)


class TestRoute:
    def post(self, client, body, headers=None):
        return client.post(qstash.JOBS_PATH, data=body, headers=headers or {})

    def test_refuses_an_unsigned_call_and_one_signed_for_another_address_and_runs_nothing(self):
        ran = []
        d, config = dispatcher_for(lambda i: ran.append(i) or {"outcome": "processed"})
        client = silent_client(d, config)
        body = json.dumps({"event_id": str(uuid.uuid4())}).encode()
        for headers in (
            {},
            {"Upstash-Signature": sign(body, "https://elsewhere.example.test/x", "current-key")},
        ):
            response = self.post(client, body, headers)
            assert response.status_code == 401
            assert response.get_json()["error"]["code"] == "invalid_signature"
        assert ran == []

    def test_runs_the_event_for_a_signed_call_with_either_key(self):
        ran = []
        d, config = dispatcher_for(lambda i: ran.append(i) or {"outcome": "processed"})
        client = silent_client(d, config)
        for key in ("current-key", "next-key"):
            event_id = str(uuid.uuid4())
            body = json.dumps({"event_id": event_id}).encode()
            response = self.post(client, body, {"Upstash-Signature": sign(body, JOBS, key)})
            assert response.status_code == 200
            assert response.get_json() == {"outcome": "processed"}
            assert ran[-1] == event_id

    def test_answers_503_while_a_retry_is_due_and_200_once_it_is_not(self):
        outcomes = iter([{"outcome": "retry"}, {"outcome": "failed"}])
        d, config = dispatcher_for(lambda i: next(outcomes))
        client = silent_client(d, config)
        body = json.dumps({"event_id": str(uuid.uuid4())}).encode()
        headers = {"Upstash-Signature": sign(body, JOBS, "current-key")}
        first = self.post(client, body, headers)
        assert first.status_code == 503
        assert first.get_json()["error"]["code"] == "handler_failed"
        assert self.post(client, body, headers).status_code == 200

    def test_drops_a_signed_message_that_is_not_an_event_id(self):
        d, config = dispatcher_for()
        client = silent_client(d, config)
        body = b'{"nothing":true}'
        response = self.post(client, body, {"Upstash-Signature": sign(body, JOBS, "current-key")})
        assert response.status_code == 200
        assert response.get_json() == {"ignored": True}

    def test_is_not_under_the_static_files(self):
        d, config = dispatcher_for()
        response = silent_client(d, config).get(qstash.JOBS_PATH, headers={"Accept": "text/html"})
        assert response.status_code in (404, 405)


def until(check, seconds=15):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return True
        time.sleep(0.1)
    return bool(check())


HOST = "host.docker.internal"


@pytest.mark.skipif(not HAVE_QSTASH, reason="the QStash development server is not running")
class TestLive:
    @pytest.fixture
    def live(self, tmp_path):
        """A real server for the mode on all interfaces, so the QStash container can reach it."""
        servers, runtimes = [], []

        def start(handlers_source):
            (tmp_path / "handlers.py").write_text(handlers_source, encoding="utf-8")
            probe = make_server("0.0.0.0", 0, create_app(make_config()))  # noqa: S104 - the container must reach it
            port = probe.server_port
            probe.server_close()
            values = {
                "DC_AUTH_MODE": "server",
                "DROPCOWBOY_API_KEY": API_KEY,
                "DROPCOWBOY_API_SECRET": API_SECRET,
                "DROPCOWBOY_SITE_ID": SITE_ID,
                "DROPCOWBOY_WEBHOOK_SECRET": WEBHOOK_SECRET,
                "DROPCOWBOY_API_BASE": "https://api.example.test",
                "STARTER_CRM_USER_ID": USER_ID,
                "STARTER_CRM_ROOT": str(tmp_path),
                "DC_WEBHOOK_HANDLERS": "./handlers.py",
                "DC_WEBHOOKS": "qstash",
                "DC_STORE": "sqlite",
                "DC_WEBHOOK_MAX_ATTEMPTS": "5",
                "DC_SQLITE_PATH": str(tmp_path / "events.sqlite"),
                "DC_PUBLIC_URL": "http://" + HOST + ":" + str(port),
                **QSTASH_DEV,
            }
            booted = bootstrap(values, tmp_path)
            assert not booted.problems, [p.message for p in booted.problems]
            log = Logger(lambda: booted.config.known_secrets, stdout=SilentStream(), stderr=SilentStream())
            app = create_app(
                booted.config, log=log, runtime=booted.runtime, ratelimit=booted.ratelimit, identity=booted.identity
            )
            server = make_server("0.0.0.0", port, app, threaded=True)  # noqa: S104
            threading.Thread(target=server.serve_forever, daemon=True).start()
            servers.append(server)
            runtimes.append(booted.runtime)
            booted.runtime.start()
            return booted, port

        yield start
        for server in servers:
            server.shutdown()
        for runtime in runtimes:
            runtime.stop()

    def record(self, booted):
        event_id = str(uuid.uuid4())
        booted.runtime.store.record(
            {
                "event_id": event_id,
                "event": "contact.rvm.status",
                "event_at": None,
                "received_at": int(time.time() * 1000),
                "attempt": 1,
                "data": {},
            },
            visible_at=0,
        )
        return event_id

    def test_delivers_a_published_event_with_a_real_signature_and_the_handler_runs_once(self, live):
        booted, _ = live(
            "calls = []\n"
            "def record(event, ctx):\n    calls.append(ctx.event_id)\n"
            'handlers = {"contact.rvm.status": record}\n'
        )
        event_id = self.record(booted)
        booted.runtime.dispatcher.dispatch(event_id)
        assert until(lambda: booted.runtime.store.get(event_id)["status"] == "processed")
        import sys  # noqa: PLC0415

        assert sys.modules["starter_crm_handlers"].calls == [event_id]

    def test_retries_after_the_backoff_when_a_handler_fails_and_finishes_when_it_recovers(self, live):
        booted, _ = live(
            "calls = []\n"
            "def flaky(event, ctx):\n"
            "    calls.append(ctx.event_id)\n"
            "    if len(calls) < 2:\n        raise RuntimeError('first attempt fails')\n"
            'handlers = {"contact.rvm.status": flaky}\n'
        )
        event_id = self.record(booted)
        booted.runtime.dispatcher.dispatch(event_id)
        assert until(lambda: booted.runtime.store.get(event_id)["status"] == "processed", 30)
        import sys  # noqa: PLC0415

        assert sys.modules["starter_crm_handlers"].calls == [event_id, event_id]

    def test_refuses_a_call_signed_with_a_key_it_does_not_know(self, live):
        import urllib.request  # noqa: PLC0415

        booted, port = live("handlers = {}\n")
        event_id = self.record(booted)
        body = json.dumps({"event_id": event_id}).encode()
        url = "http://" + HOST + ":" + str(port) + qstash.JOBS_PATH
        request = urllib.request.Request(
            "http://127.0.0.1:" + str(port) + qstash.JOBS_PATH,
            data=body,
            method="POST",
            headers={"Upstash-Signature": sign(body, url, "a-key-that-is-not-configured")},
        )
        with pytest.raises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=5)  # noqa: S310
        assert caught.value.code == 401
        assert booted.runtime.store.get(event_id)["status"] == "received"
