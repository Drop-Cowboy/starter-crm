"""The ``sqs`` webhook mode: an Amazon SQS queue of event ids, worked by this process or by the worker.

Where it sits: ``DC_WEBHOOKS=sqs``, the default on AWS when ``DC_STORE=dynamodb`` and ``DC_SQS_QUEUE_URL`` is set. The
webhook records the event in the store, sends a message to the queue and answers 200 only after SQS has accepted it. A
message carries just the ``event_id`` (and the site), never the contact's data; the worker reads the event from the
store. The Node server speaks the same messages, so a Node and a Python server can work one queue.

- The worker long-polls the queue, runs the handlers for each message and deletes the message when the event is
  finished: ``processed``, ``failed`` (attempts used up, kept in the store for ``webhooks:replay``), ``skipped``
  (already finished) or ``missing``.
- When a handler fails and another attempt is due, the message stays and its visibility timeout is set to the backoff
  (1 s, 2 s, 4 s, up to 5 minutes), so SQS hands it out again at the right time.
- SQS delivers at least once, so a message can arrive twice, and the maintenance sweep re-queues events that were
  recorded but whose message was lost. Handlers must be idempotent, as for every webhook mode.
- The queue's own redrive policy (the CloudFormation template sets one) moves a message that keeps crashing the
  worker, which is not the same as a failing handler, to a dead-letter queue after ``maxReceiveCount`` receives. The
  event stays ``received`` in the store and the sweep queues it again.
- The queue's visibility timeout must be longer than your slowest handler, or SQS hands the message to a second
  worker while the first is still running.
- A blocking boto3 call cannot be interrupted, so this worker polls for 5 seconds at a time (the Node worker polls
  for 20), which is what lets a stop finish within a few seconds.

Dispatcher interface: see ``store.py``.

CONTRACT.md: "POST /webhooks/dropcowboy" (Processing).
Env: DC_SQS_QUEUE_URL, AWS_REGION, DC_WORKER_IN_PROCESS. What a customer changes: nothing.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import urlsplit

from ...aws_util import LOCAL_HOSTS, client_config, validate_aws
from ...problems import BootProblem, problem
from ...tls import allows_plaintext

name = "sqs"
config_keys = [
    "DC_SQS_QUEUE_URL",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_ENDPOINT_URL",
    "AWS_ENDPOINT_URL_SQS",
    "DC_WORKER_IN_PROCESS",
]

# Messages handled at once per worker. Handlers are I/O-bound.
CONCURRENCY = 5

# How long one receive waits for a message, in seconds. boto3 cannot abort a call in flight, so a stop waits out the
# poll in progress: this stays well inside the five-second grace most hosts give a process after SIGTERM.
WAIT_SECONDS = 2

# SQS's longest visibility timeout: 12 hours.
MAX_VISIBILITY_SECONDS = 43200

# How long the worker rests after a receive fails, so an outage is not a busy loop.
ERROR_REST_SECONDS = 3


def validate(env: Mapping[str, str]) -> list[BootProblem]:
    """Checks the queue address and the region.

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    problems = validate_aws(env, "DC_WEBHOOKS=sqs", "SQS")
    raw = (env.get("DC_SQS_QUEUE_URL") or "").strip()
    if raw == "":
        problems.append(
            problem(
                "missing_sqs_queue_url",
                "DC_WEBHOOKS=sqs needs DC_SQS_QUEUE_URL.",
                "Set DC_SQS_QUEUE_URL to the queue's URL (the CloudFormation template outputs it), "
                "or choose another DC_WEBHOOKS mode.",
            )
        )
        return problems
    parts = None
    try:
        parts = urlsplit(raw)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError("not a URL")
    except ValueError:
        parts = None
        problems.append(
            problem(
                "invalid_sqs_queue_url",
                'DC_SQS_QUEUE_URL is not a URL (got "' + raw + '").',
                "Set it to the queue's URL: the WebhookQueueUrl output of the CloudFormation template, "
                "or the URL shown for the queue in the AWS console.",
            )
        )
    if (
        parts is not None
        and env.get("DC_ENV") == "production"
        and parts.scheme != "https"
        and parts.hostname not in LOCAL_HOSTS
        and not allows_plaintext(env)
    ):
        problems.append(
            problem(
                "insecure_sqs_queue_url",
                "DC_SQS_QUEUE_URL must use https:// in production.",
                "Use the queue's https:// URL. Localhost is exempt, and so is a private network you control when "
                "DC_INSECURE_PRIVATE_SERVICES=on.",
            )
        )
    return problems


class SqsDispatcher:
    """An SQS queue and, optionally, a worker thread that handles its messages."""

    visible_delay_ms = 120000

    def __init__(
        self,
        config: Any,
        env: Mapping[str, str],
        processor: Any,
        log: Any,
        client: Any = None,
        wait_seconds: int = WAIT_SECONDS,
    ):
        """Prepares the dispatcher; nothing connects until ``start()`` or the first ``dispatch()``.

        Args:
            config: The loaded config (site id, worker setting).
            env: The merged environment (queue URL, region, endpoint).
            processor: The processor that runs handlers.
            log: The redacting logger.
            client: A ready ``boto3.client("sqs")`` (tests).
            wait_seconds: How long one receive waits (replaced in tests).
        """
        self._config = config
        self._env = env
        self._processor = processor
        self._log = log
        self._client = client
        self._owns_client = client is None
        self._queue_url = (env.get("DC_SQS_QUEUE_URL") or "").strip()
        self._site_id = config.site_id or "default"
        self._wait = wait_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_error: Exception | None = None
        self._lock = threading.Lock()

    def _sqs(self) -> Any:
        """The client, built on first use (the SDK is only imported when this mode is chosen)."""
        with self._lock:
            if self._client is None:
                import boto3

                self._client = boto3.client("sqs", **client_config(self._env, "SQS"))
            return self._client

    def check(self) -> None:
        """Checks the queue exists and can be read, naming its address if not.

        Raises:
            RuntimeError: When the queue could not be read.
        """
        try:
            self._sqs().get_queue_attributes(QueueUrl=self._queue_url, AttributeNames=["QueueArn"])
        except Exception as err:  # noqa: BLE001 - boto3 raises its own hierarchy
            raise RuntimeError("Cannot read the SQS queue " + self._queue_url + ": " + err.__class__.__name__) from None

    def dispatch(self, event_id: str) -> dict:
        """Sends the event id to the queue and returns once SQS has accepted it.

        Args:
            event_id: The recorded event.

        Returns:
            ``{"outcome": "queued"}``.
        """
        self._sqs().send_message(
            QueueUrl=self._queue_url,
            MessageBody=json.dumps({"event_id": event_id, "site_id": self._site_id}, separators=(",", ":")),
        )
        return {"outcome": "queued"}

    def sweep(self, event_ids: list[str]) -> None:
        """Queues events again that were recorded but never handled.

        Args:
            event_ids: The stale events.
        """
        for event_id in event_ids:
            self.dispatch(event_id)

    def start(self) -> None:
        """Checks the queue, then starts the worker thread, unless ``DC_WORKER_IN_PROCESS=off`` or it is running."""
        self.check()
        if not self._config.events.worker_in_process or self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._work, name="starter-crm-sqs", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stops the worker after the messages in hand are settled, then closes the client."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
            self._thread = None
        if self._client is not None and self._owns_client:
            self._client.close()
            self._client = None

    def ready(self) -> bool:
        """Whether the queue answers and the last receive worked.

        Returns:
            False when the queue cannot be read.
        """
        if self._last_error is not None:
            return False
        try:
            self._sqs().get_queue_attributes(QueueUrl=self._queue_url, AttributeNames=["QueueArn"])
            return True
        except Exception:  # noqa: BLE001 - any failure means not ready
            return False

    def _handle(self, message: dict) -> None:
        """Handles one message and settles it with SQS."""
        client = self._sqs()
        event_id = None
        try:
            body = json.loads(message.get("Body", ""))
            if isinstance(body, dict) and isinstance(body.get("event_id"), str) and body["event_id"] != "":
                event_id = body["event_id"]
        except ValueError:
            pass
        if event_id is None:
            self._log.warn("Dropping an SQS message that is not an event id: " + str(message.get("MessageId")))
            client.delete_message(QueueUrl=self._queue_url, ReceiptHandle=message["ReceiptHandle"])
            return
        result = self._processor.process(event_id)
        if result["outcome"] == "retry":
            try:
                received = int((message.get("Attributes") or {}).get("ApproximateReceiveCount") or 1)
            except ValueError:
                received = 1
            # Imported here: processor imports the provider package, so a top-level import is a cycle that breaks
            # any entry point (the worker) that happens to load processor first.
            from ...processor import backoff_ms

            seconds = min(MAX_VISIBILITY_SECONDS, max(1, -(-backoff_ms(received) // 1000)))
            client.change_message_visibility(
                QueueUrl=self._queue_url, ReceiptHandle=message["ReceiptHandle"], VisibilityTimeout=seconds
            )
            return
        client.delete_message(QueueUrl=self._queue_url, ReceiptHandle=message["ReceiptHandle"])

    def _settle(self, message: dict) -> None:
        """Handles a message; one that cannot be settled is left alone, so SQS delivers it again."""
        try:
            self._handle(message)
        except Exception as err:  # noqa: BLE001 - one message must not stop the worker
            self._log.error(
                "SQS message " + str(message.get("MessageId")) + " could not be settled; SQS will deliver it again:",
                str(err),
            )

    def _work(self) -> None:
        """The worker: receives a batch, handles it, and goes again until stopped."""
        with ThreadPoolExecutor(max_workers=CONCURRENCY, thread_name_prefix="starter-crm-sqs-handler") as pool:
            while not self._stop.is_set():
                try:
                    received = self._sqs().receive_message(
                        QueueUrl=self._queue_url,
                        MaxNumberOfMessages=CONCURRENCY,
                        WaitTimeSeconds=self._wait,
                        MessageSystemAttributeNames=["ApproximateReceiveCount"],
                    )
                    self._last_error = None
                except Exception as err:  # noqa: BLE001 - any client error: rest and try again
                    self._last_error = err
                    self._log.warn("SQS receive failed: " + err.__class__.__name__)
                    if self._stop.wait(ERROR_REST_SECONDS):
                        return
                    continue
                # Every message in the batch finishes before the next receive, so a stop waits for the work in hand.
                for future in [pool.submit(self._settle, message) for message in received.get("Messages", [])]:
                    future.result()


def create(ctx: Any, client: Any = None, wait_seconds: int = WAIT_SECONDS) -> SqsDispatcher:
    """Creates the dispatcher.

    Args:
        ctx: The provider context (``config``, ``env``, ``processor``, ``log``).
        client: A ready client, for tests.
        wait_seconds: How long one receive waits, for tests.

    Returns:
        The dispatcher instance.
    """
    return SqsDispatcher(ctx.config, ctx.env, ctx.processor, ctx.log, client, wait_seconds)
