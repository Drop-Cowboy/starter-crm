"""The ``sqs`` webhook mode against ElasticMQ (tests/services.compose.yml), the SQS-compatible stand-in.

The suites skip, with a reason, when it is not running. The dispatcher is driven with a fake processor so each outcome
is exact. The Node server runs the same cases in ``server/node/test/sqs.test.js``.
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from pathlib import Path

import boto3
import pytest
from helpers import make_config
from services import HAVE_SQS, SQS_URL, aws_test_env

from starter_crm.providers import ProviderContext
from starter_crm.providers.webhooks import sqs

SITE = str(uuid.uuid4())
STARTER_ROOT = Path(__file__).resolve().parents[3]


def urlof(name: str) -> str:
    """ElasticMQ answers with its own in-container address, so a host test builds the URL from the endpoint."""
    return SQS_URL + "/000000000000/" + name


@pytest.fixture(scope="module")
def admin():
    if not HAVE_SQS:
        pytest.skip("ElasticMQ is not running")
    return boto3.client(
        "sqs",
        region_name="us-east-1",
        endpoint_url=SQS_URL,
        aws_access_key_id="test",
        aws_secret_access_key="test",
    )


@pytest.fixture
def make_queue(admin):
    def make(**attributes):
        name = "webhooks-" + str(uuid.uuid4())
        admin.create_queue(QueueName=name, Attributes={"VisibilityTimeout": "1", **attributes})
        return name

    return make


def depth(admin, name):
    a = admin.get_queue_attributes(QueueUrl=urlof(name), AttributeNames=["All"])["Attributes"]
    return (
        int(a["ApproximateNumberOfMessages"])
        + int(a["ApproximateNumberOfMessagesNotVisible"])
        + int(a["ApproximateNumberOfMessagesDelayed"])
    )


def until(check, seconds=8):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return True
        time.sleep(0.05)
    return bool(check())


class Warnings:
    """A logger that keeps what it is told, so a test can read it."""

    def __init__(self):
        self.lines: list[str] = []

    def warn(self, *args):
        self.lines.append(" ".join(str(a) for a in args))

    error = warn

    def info(self, *args):
        pass


class Processor:
    def __init__(self, fn):
        self.fn = fn

    def process(self, event_id):
        return self.fn(event_id)


@pytest.fixture
def dispatcher():
    opened = []
    log = Warnings()

    def build(queue, fn, worker_in_process=True, wait_seconds=1):
        config = make_config(
            DC_WORKER_IN_PROCESS="on" if worker_in_process else "off",
            DROPCOWBOY_SITE_ID=SITE,
            DC_STORE="dynamodb",
            DC_FANOUT="poll",
            **aws_test_env(),
        )
        env = aws_test_env(DC_SQS_QUEUE_URL=urlof(queue))
        ctx = ProviderContext(config, env, log, STARTER_ROOT, None, Processor(fn))
        made = sqs.create(ctx, wait_seconds=wait_seconds)
        opened.append(made)
        return made

    build.log = log
    yield build
    for made in opened:
        made.stop()


class TestSqs:
    def test_a_worker_processes_the_event_id_and_deletes_the_message(self, admin, make_queue, dispatcher):
        queue = make_queue()
        seen = []
        d = dispatcher(queue, lambda i: seen.append(i) or {"outcome": "processed"})
        d.start()
        event_id = str(uuid.uuid4())
        assert d.dispatch(event_id) == {"outcome": "queued"}
        assert until(lambda: len(seen) == 1)
        assert seen == [event_id]
        assert until(lambda: depth(admin, queue) == 0)

    def test_puts_only_the_event_id_and_the_site_on_the_queue(self, admin, make_queue, dispatcher):
        queue = make_queue()
        d = dispatcher(queue, lambda i: {"outcome": "processed"}, worker_in_process=False)
        event_id = str(uuid.uuid4())
        d.dispatch(event_id)
        got = admin.receive_message(QueueUrl=urlof(queue), WaitTimeSeconds=2)
        assert json.loads(got["Messages"][0]["Body"]) == {"event_id": event_id, "site_id": SITE}

    def test_leaves_the_queue_alone_when_workers_are_off(self, admin, make_queue, dispatcher):
        queue = make_queue()
        seen = []
        d = dispatcher(queue, lambda i: seen.append(i) or {"outcome": "processed"}, worker_in_process=False)
        d.start()
        d.dispatch(str(uuid.uuid4()))
        time.sleep(1.5)
        assert seen == []
        assert depth(admin, queue) == 1

    def test_keeps_the_message_for_the_backoff_after_a_retry_then_processes_it_again(
        self, admin, make_queue, dispatcher
    ):
        queue = make_queue(VisibilityTimeout="30")
        times = []

        def process(_):
            times.append(time.monotonic())
            return {"outcome": "retry", "error": "handler failed"} if len(times) == 1 else {"outcome": "processed"}

        d = dispatcher(queue, process)
        d.start()
        d.dispatch(str(uuid.uuid4()))
        assert until(lambda: len(times) == 2, 10)
        # The first backoff is one second; the queue's own timeout is 30, so only the backoff can explain this gap.
        assert 0.9 <= times[1] - times[0] < 5
        assert until(lambda: depth(admin, queue) == 0)

    def test_deletes_the_message_for_an_event_that_failed_for_good_was_skipped_or_is_missing(
        self, admin, make_queue, dispatcher
    ):
        queue = make_queue()
        outcomes = iter(["failed", "skipped", "missing"])
        calls = []

        def process(i):
            calls.append(i)
            return {"outcome": next(outcomes)}

        d = dispatcher(queue, process)
        d.start()
        for _ in range(3):
            d.dispatch(str(uuid.uuid4()))
        assert until(lambda: len(calls) == 3)
        assert until(lambda: depth(admin, queue) == 0)
        time.sleep(1.5)
        assert len(calls) == 3

    def test_leaves_a_message_that_crashes_the_processor_so_sqs_delivers_it_again(self, admin, make_queue, dispatcher):
        queue = make_queue()
        calls = []

        def process(i):
            calls.append(i)
            if len(calls) == 1:
                raise RuntimeError("store is down")
            return {"outcome": "processed"}

        d = dispatcher(queue, process)
        d.start()
        d.dispatch(str(uuid.uuid4()))
        assert until(lambda: len(calls) == 2, 10)
        assert any("store is down" in line for line in dispatcher.log.lines)
        assert until(lambda: depth(admin, queue) == 0)

    def test_drops_a_message_that_is_not_an_event_id(self, admin, make_queue, dispatcher):
        queue = make_queue()
        calls = []
        d = dispatcher(queue, lambda i: calls.append(i) or {"outcome": "processed"})
        d.start()
        admin.send_message(QueueUrl=urlof(queue), MessageBody="not json")
        admin.send_message(QueueUrl=urlof(queue), MessageBody=json.dumps({"event_id": 7}))
        assert until(lambda: depth(admin, queue) == 0)
        assert calls == []
        assert any("not an event id" in line for line in dispatcher.log.lines)

    def test_the_queues_redrive_policy_moves_a_message_that_keeps_crashing_to_the_dead_letter_queue(
        self, admin, make_queue, dispatcher
    ):
        dead = make_queue()
        arn = admin.get_queue_attributes(QueueUrl=urlof(dead), AttributeNames=["QueueArn"])["Attributes"]["QueueArn"]
        queue = make_queue(RedrivePolicy=json.dumps({"deadLetterTargetArn": arn, "maxReceiveCount": 2}))
        calls = []

        def process(i):
            calls.append(i)
            raise RuntimeError("always crashes")

        d = dispatcher(queue, process)
        d.start()
        event_id = str(uuid.uuid4())
        d.dispatch(event_id)
        assert until(lambda: depth(admin, dead) == 1, 15)
        assert len(calls) == 2
        d.stop()
        got = admin.receive_message(QueueUrl=urlof(dead), WaitTimeSeconds=2)
        assert json.loads(got["Messages"][0]["Body"])["event_id"] == event_id

    def test_a_sweep_queues_every_event_it_names_again(self, make_queue, dispatcher):
        queue = make_queue()
        seen = set()
        d = dispatcher(queue, lambda i: seen.add(i) or {"outcome": "processed"})
        d.start()
        ids = [str(uuid.uuid4()) for _ in range(3)]
        d.sweep(ids)
        assert until(lambda: len(seen) == 3)

    def test_handles_several_messages_at_once(self, make_queue, dispatcher):
        queue = make_queue()
        lock = threading.Lock()
        state = {"running": 0, "peak": 0, "done": 0}

        def process(_):
            with lock:
                state["running"] += 1
                state["peak"] = max(state["peak"], state["running"])
            time.sleep(0.3)
            with lock:
                state["running"] -= 1
                state["done"] += 1
            return {"outcome": "processed"}

        d = dispatcher(queue, process)
        d.sweep([str(uuid.uuid4()) for _ in range(5)])
        d.start()
        assert until(lambda: state["done"] == 5)
        assert state["peak"] > 1

    def test_stops_after_the_poll_and_finishes_the_message_in_hand_first(self, admin, make_queue, dispatcher):
        queue = make_queue()
        finished = []

        def process(_):
            time.sleep(0.6)
            finished.append(True)
            return {"outcome": "processed"}

        d = dispatcher(queue, process, wait_seconds=1)
        d.dispatch(str(uuid.uuid4()))
        d.start()
        time.sleep(0.3)
        d.stop()
        assert finished == [True]
        assert depth(admin, queue) == 0

    def test_reports_ready_while_the_queue_answers_and_not_after_it_is_gone(self, admin, make_queue, dispatcher):
        queue = make_queue()
        d = dispatcher(queue, lambda i: {"outcome": "processed"})
        assert d.ready() is True
        admin.delete_queue(QueueUrl=urlof(queue))
        assert d.ready() is False

    def test_refuses_to_start_when_the_queue_does_not_exist_naming_its_address(self, dispatcher):
        missing = "missing-" + str(uuid.uuid4())
        d = dispatcher(missing, lambda i: {"outcome": "processed"})
        with pytest.raises(RuntimeError, match=missing):
            d.start()


class TestSqsSettings:
    def test_needs_a_queue_url_and_a_region(self):
        url = "https://queue.example.test/q"
        assert [p.code for p in sqs.validate({"AWS_REGION": "us-east-1"})] == ["missing_sqs_queue_url"]
        assert [p.code for p in sqs.validate({"DC_SQS_QUEUE_URL": url})] == ["missing_aws_region"]
        assert sqs.validate({"AWS_REGION": "us-east-1", "DC_SQS_QUEUE_URL": url}) == []

    def test_rejects_a_queue_url_that_is_not_a_url_and_plain_http_in_production_off_this_machine(self):
        base = {"AWS_REGION": "r"}
        assert [p.code for p in sqs.validate({**base, "DC_SQS_QUEUE_URL": "queue"})] == ["invalid_sqs_queue_url"]
        prod = {**base, "DC_ENV": "production"}
        bad = sqs.validate({**prod, "DC_SQS_QUEUE_URL": "http://queue.example.com/1/q"})
        assert [p.code for p in bad] == ["insecure_sqs_queue_url"]
        assert sqs.validate({**prod, "DC_SQS_QUEUE_URL": "http://127.0.0.1:9324/1/q"}) == []
        private = {**prod, "DC_INSECURE_PRIVATE_SERVICES": "on", "DC_SQS_QUEUE_URL": "http://queue.example.test/1/q"}
        assert sqs.validate(private) == []
