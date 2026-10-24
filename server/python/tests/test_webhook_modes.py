"""The handlers file and the three webhook modes (inline, store, bullmq), end to end through the real app."""

from __future__ import annotations

import json
import sys
import time
import uuid
from pathlib import Path

import pytest
from helpers import API_KEY, API_SECRET, SITE_ID, USER_ID, WEBHOOK_SECRET, SilentStream, sign
from services import HAVE_DYNAMODB, HAVE_REDIS, HAVE_SQS, REDIS_URL, SQS_URL, aws_test_env

from starter_crm.app import create_app
from starter_crm.bootstrap import bootstrap
from starter_crm.handlers import load_handlers
from starter_crm.log import Logger

STARTER_ROOT = Path(__file__).resolve().parents[3]

HANDLERS = """
calls = []
failures = {}

def record(event, ctx):
    calls.append((event["event"], ctx.event_id, ctx.attempt))

def flaky(event, ctx):
    calls.append((event["event"], ctx.event_id, ctx.attempt))
    if failures.get(ctx.event_id, 0) > 0:
        failures[ctx.event_id] -= 1
        raise RuntimeError("crm is down")

def slow(event, ctx):
    ctx.signal.wait(2)
    calls.append(("signal", ctx.signal.is_set()))

handlers = {"contact.msg.received": flaky, "contact.rvm.status": record, "contact.slow": slow}
"""


def boot(tmp_path, handlers=HANDLERS, **env):
    """Boots like ``python -m starter_crm`` with a handlers file; returns (booted, handlers module)."""
    (tmp_path / "handlers.py").write_text(handlers, encoding="utf-8")
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
        "DC_SQLITE_PATH": str(tmp_path / "events.sqlite"),
        "DC_OUTBOX_POLL_MS": "100",
    }
    values.update(env)
    if values.get("DC_STORE") == "redis":
        values.setdefault("DC_DATA", "sqlite")
    booted = bootstrap(values, tmp_path)
    assert not booted.problems, [p.message for p in booted.problems]
    return booted, sys.modules["starter_crm_handlers"]


def client_for(booted):
    silent = Logger(lambda: booted.config.known_secrets, stdout=SilentStream(), stderr=SilentStream())
    app = create_app(
        booted.config, log=silent, runtime=booted.runtime, ratelimit=booted.ratelimit, identity=booted.identity
    )
    return app.test_client(use_cookies=False)


def deliver(client, event, event_id=None):
    event_id = event_id or str(uuid.uuid4())
    body = json.dumps({"event_id": event_id, "event": event, "data": {"contact_id": "c-9"}})
    timestamp = str(int(time.time()))
    response = client.post(
        "/webhooks/dropcowboy",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Signature": sign(body, WEBHOOK_SECRET, timestamp),
            "X-Timestamp": timestamp,
            "X-Signature-Version": "v1",
            "X-Event-Id": event_id,
        },
    )
    return event_id, response


def wait_for(check, seconds=8):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.05)
    return check()


@pytest.fixture
def started():
    runtimes = []
    yield runtimes
    for runtime in runtimes:
        runtime.stop()


def test_the_handlers_loader_reports_each_way_a_file_can_be_wrong(tmp_path):
    class Config:
        class events:
            handlers_path = "./h.py"

        root = tmp_path

    assert load_handlers(type("C", (), {"events": type("E", (), {"handlers_path": None}), "root": tmp_path})) == (
        {},
        None,
    )
    (tmp_path / "h.py").write_text("handlers = {'*': 5}", encoding="utf-8")
    assert "is not a function" in load_handlers(Config)[1]
    (tmp_path / "h.py").write_text("x = 1", encoding="utf-8")
    assert "must define `handlers`" in load_handlers(Config)[1]
    (tmp_path / "h.py").write_text("raise RuntimeError('broken file')", encoding="utf-8")
    assert "broken file" in load_handlers(Config)[1]
    assert (
        "could not be loaded"
        in load_handlers(type("C", (), {"events": type("E", (), {"handlers_path": "./nope.py"}), "root": tmp_path}))[1]
    )


class TestInline:
    def test_runs_the_handler_before_answering_and_pushes_the_event(self, tmp_path, started):
        booted, module = boot(tmp_path, DC_WEBHOOKS="inline")
        booted.runtime.start()
        started.append(booted.runtime)
        event_id, response = deliver(client_for(booted), "contact.rvm.status")
        assert response.status_code == 200
        assert [c[1] for c in module.calls] == [event_id]
        assert booted.runtime.store.get(event_id)["status"] == "processed"

    def test_answers_503_while_a_handler_fails_and_200_once_it_recovers(self, tmp_path, started):
        booted, module = boot(tmp_path, DC_WEBHOOKS="inline")
        booted.runtime.start()
        started.append(booted.runtime)
        client = client_for(booted)
        event_id = str(uuid.uuid4())
        module.failures[event_id] = 1
        _, first = deliver(client, "contact.msg.received", event_id)
        _, second = deliver(client, "contact.msg.received", event_id)
        assert (first.status_code, second.status_code) == (503, 200)
        assert booted.runtime.store.get(event_id)["status"] == "processed"

    def test_a_slow_handler_is_signalled_when_its_budget_runs_out(self, tmp_path, started):
        booted, module = boot(tmp_path, DC_WEBHOOKS="inline", DC_WEBHOOK_HANDLER_BUDGET_MS="200")
        booted.runtime.processor._handlers["contact.slow"] = module.slow
        booted.runtime.start()
        started.append(booted.runtime)
        began = time.monotonic()
        _, response = deliver(client_for(booted), "contact.slow")
        assert response.status_code == 200
        assert ("signal", True) in module.calls
        assert time.monotonic() - began < 1.5


class TestStoreOutbox:
    def test_answers_before_the_handler_runs_and_the_worker_finishes_it(self, tmp_path, started):
        booted, module = boot(tmp_path, DC_STORE="sqlite", DC_WEBHOOKS="store")
        booted.runtime.start()
        started.append(booted.runtime)
        event_id, response = deliver(client_for(booted), "contact.rvm.status")
        assert response.status_code == 200
        assert wait_for(lambda: booted.runtime.store.get(event_id)["status"] == "processed")
        assert [c[1] for c in module.calls] == [event_id]

    def test_retries_a_failing_handler_with_backoff_until_it_succeeds(self, tmp_path, started):
        booted, module = boot(tmp_path, DC_STORE="sqlite", DC_WEBHOOKS="store")
        booted.runtime.start()
        started.append(booted.runtime)
        event_id = str(uuid.uuid4())
        module.failures[event_id] = 1
        deliver(client_for(booted), "contact.msg.received", event_id)
        assert wait_for(lambda: booted.runtime.store.get(event_id)["status"] == "processed", 10)
        assert [c[2] for c in module.calls] == [1, 2]

    def test_fails_an_event_for_good_after_max_attempts_and_replay_runs_it_again(self, tmp_path, started):
        booted, module = boot(tmp_path, DC_STORE="sqlite", DC_WEBHOOKS="store", DC_WEBHOOK_MAX_ATTEMPTS="1")
        booted.runtime.start()
        started.append(booted.runtime)
        event_id = str(uuid.uuid4())
        module.failures[event_id] = 5
        deliver(client_for(booted), "contact.msg.received", event_id)
        assert wait_for(lambda: booted.runtime.store.get(event_id)["status"] == "failed")
        module.failures[event_id] = 0
        assert booted.runtime.store.replay(event_id) is True
        booted.runtime.dispatcher.dispatch(event_id)
        assert wait_for(lambda: booted.runtime.store.get(event_id)["status"] == "processed")

    def test_an_event_recorded_before_a_crash_is_handled_by_the_next_start(self, tmp_path, started):
        first, module = boot(
            tmp_path, DC_STORE="sqlite", DC_WEBHOOKS="store", DC_WORKER_IN_PROCESS="off", DC_FANOUT="poll"
        )
        first.runtime.start()
        event_id, response = deliver(client_for(first), "contact.rvm.status")
        assert response.status_code == 200
        time.sleep(0.4)
        assert module.calls == []
        first.runtime.stop()

        second, module = boot_again(tmp_path, DC_STORE="sqlite", DC_WEBHOOKS="store")
        second.runtime.start()
        started.append(second.runtime)
        assert wait_for(lambda: second.runtime.store.get(event_id)["status"] == "processed")
        assert [c[1] for c in module.calls] == [event_id]

    def test_readiness_follows_the_store(self, tmp_path, started):
        booted, _ = boot(tmp_path, DC_STORE="sqlite", DC_WEBHOOKS="store")
        booted.runtime.start()
        started.append(booted.runtime)
        assert booted.runtime.ready() is True
        booted.runtime.store.close()
        assert booted.runtime.ready() is False


def boot_again(tmp_path, **env):
    """Boots a second process on the same directory: the files already exist, so only the config is rebuilt."""
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
        "DC_SQLITE_PATH": str(tmp_path / "events.sqlite"),
        "DC_OUTBOX_POLL_MS": "100",
    }
    values.update(env)
    booted = bootstrap(values, tmp_path)
    assert not booted.problems, [p.message for p in booted.problems]
    return booted, sys.modules["starter_crm_handlers"]


@pytest.mark.skipif(not HAVE_REDIS, reason="Valkey is not running")
class TestBullmq:
    def env(self):
        return {
            "DC_STORE": "redis",
            "DC_WEBHOOKS": "bullmq",
            "DC_REDIS_URL": REDIS_URL,
            "DROPCOWBOY_SITE_ID": str(uuid.uuid4()),
        }

    def test_queues_the_event_id_and_the_worker_runs_the_handler(self, tmp_path, started):
        booted, module = boot(tmp_path, **self.env())
        booted.runtime.start()
        started.append(booted.runtime)
        event_id, response = deliver(client_for(booted), "contact.rvm.status")
        assert response.status_code == 200
        assert wait_for(lambda: booted.runtime.store.get(event_id)["status"] == "processed")
        assert [c[1] for c in module.calls] == [event_id]

    def test_redelivering_a_finished_event_does_not_run_its_handler_again(self, tmp_path, started):
        booted, module = boot(tmp_path, **self.env())
        booted.runtime.start()
        started.append(booted.runtime)
        client = client_for(booted)
        event_id, _ = deliver(client, "contact.rvm.status")
        assert wait_for(lambda: booted.runtime.store.get(event_id)["status"] == "processed")
        _, again = deliver(client, "contact.rvm.status", event_id)
        assert again.get_json() == {"received": True, "duplicate": True}
        time.sleep(0.5)
        assert len(module.calls) == 1

    def test_retries_a_failing_handler_through_the_queue(self, tmp_path, started):
        booted, module = boot(tmp_path, **self.env())
        booted.runtime.start()
        started.append(booted.runtime)
        event_id = str(uuid.uuid4())
        module.failures[event_id] = 1
        deliver(client_for(booted), "contact.msg.received", event_id)
        assert wait_for(lambda: booted.runtime.store.get(event_id)["status"] == "processed", 15)
        assert len(module.calls) == 2

    def test_answers_503_when_redis_cannot_take_the_job(self, tmp_path, started):
        booted, _ = boot(tmp_path, **self.env())
        booted.runtime.start()

        async def refuse(*args, **kwargs):
            raise ConnectionError("redis is down")

        booted.runtime.dispatcher._queue.add = refuse
        event_id, response = deliver(client_for(booted), "contact.rvm.status")
        assert response.status_code == 503
        assert response.get_json()["error"]["code"] == "webhook_not_queued"
        assert booted.runtime.store.get(event_id)["status"] == "received"

        # BullMQ for Python's graceful close can wait indefinitely on the worker's idle read.
        began = time.monotonic()
        booted.runtime.stop()
        assert time.monotonic() - began < 8


@pytest.mark.skipif(not (HAVE_DYNAMODB and HAVE_SQS), reason="dynamodb-local and ElasticMQ are not running")
class TestSqsMode:
    def env(self):
        import boto3

        name = "webhooks-" + str(uuid.uuid4())
        boto3.client(
            "sqs",
            region_name="us-east-1",
            endpoint_url=SQS_URL,
            aws_access_key_id="test",
            aws_secret_access_key="test",
        ).create_queue(QueueName=name, Attributes={"VisibilityTimeout": "1"})
        return aws_test_env(
            DC_STORE="dynamodb",
            DC_WEBHOOKS="sqs",
            DC_SQS_QUEUE_URL=SQS_URL + "/000000000000/" + name,
            DROPCOWBOY_SITE_ID=str(uuid.uuid4()),
        )

    def test_queues_the_event_id_and_the_worker_runs_the_handler(self, tmp_path, started):
        booted, module = boot(tmp_path, **self.env())
        booted.runtime.start()
        started.append(booted.runtime)
        event_id, response = deliver(client_for(booted), "contact.rvm.status")
        assert response.status_code == 200
        assert wait_for(lambda: booted.runtime.store.get(event_id)["status"] == "processed")
        assert [c[1] for c in module.calls] == [event_id]

    def test_redelivering_a_finished_event_does_not_run_its_handler_again(self, tmp_path, started):
        booted, module = boot(tmp_path, **self.env())
        booted.runtime.start()
        started.append(booted.runtime)
        client = client_for(booted)
        event_id, _ = deliver(client, "contact.rvm.status")
        assert wait_for(lambda: booted.runtime.store.get(event_id)["status"] == "processed")
        _, again = deliver(client, "contact.rvm.status", event_id)
        assert again.get_json() == {"received": True, "duplicate": True}
        time.sleep(0.5)
        assert len(module.calls) == 1

    def test_retries_a_failing_handler_through_the_queue(self, tmp_path, started):
        booted, module = boot(tmp_path, **self.env())
        booted.runtime.start()
        started.append(booted.runtime)
        event_id = str(uuid.uuid4())
        module.failures[event_id] = 1
        deliver(client_for(booted), "contact.msg.received", event_id)
        assert wait_for(lambda: booted.runtime.store.get(event_id)["status"] == "processed", 15)
        assert len(module.calls) == 2

    def test_answers_503_when_the_queue_cannot_take_the_message(self, tmp_path, started):
        booted, _ = boot(tmp_path, **self.env())
        booted.runtime.start()
        started.append(booted.runtime)

        def refuse(*args, **kwargs):
            raise ConnectionError("sqs is down")

        booted.runtime.dispatcher._sqs().send_message = refuse
        event_id, response = deliver(client_for(booted), "contact.rvm.status")
        assert response.status_code == 503
        assert response.get_json()["error"]["code"] == "webhook_not_queued"
        assert booted.runtime.store.get(event_id)["status"] == "received"
