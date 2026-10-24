"""The ``bullmq`` webhook mode: a Redis queue of event ids, worked by BullMQ for Python.

Where it sits: ``DC_WEBHOOKS=bullmq``, the default when ``DC_REDIS_URL`` is set and the store is
durable and shared. The webhook records the event, adds a job to the queue, and answers 200 only after
Redis has accepted the job. Jobs carry just the ``event_id``; the worker reads the event from the store,
so contact data never sits in the queue.

- The job id is the ``event_id``, so a duplicate delivery never queues twice.
- Backoff is exponential, up to ``DC_WEBHOOK_MAX_ATTEMPTS``. BullMQ's failed set is the dead-letter list.
- The queue name and prefix are the same in the Node server (BullMQ for Python shares the queue format),
  so a Node server and a Python server can work one queue.
- Workers run in the web process by default. ``DC_WORKER_IN_PROCESS=off`` plus
  ``python -m starter_crm.worker`` runs them separately.
- It does not run against a Redis cluster (``DC_REDIS_CLUSTER=on``): BullMQ for Python cannot take a cluster client,
  so start-up reports ``bullmq_cluster_unsupported`` and says what to set instead. The Node server supports it.
- Redis must use ``maxmemory-policy noeviction``, or BullMQ can lose jobs. Start-up checks it and refuses
  to continue otherwise.

BullMQ for Python is asyncio-based and the rest of this server is threaded, so the queue and worker run
on one event loop in a background thread. ``dispatch()`` hands the add to that loop and waits for
Redis to accept it, so the webhook never answers before the job is queued.

Dispatcher interface: see ``store.py``.

CONTRACT.md: "POST /webhooks/dropcowboy" (Processing).
Env: DC_REDIS_URL, DC_WORKER_IN_PROCESS. What a customer changes: nothing.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import Mapping
from typing import Any

from ...problems import BootProblem, problem
from ...redis_util import QUEUE_NAME, bullmq_prefix, connect_redis, redis_cluster, redis_url, validate_redis

name = "bullmq"
config_keys = ["DC_REDIS_URL", "REDIS_URL", "DC_REDIS_CLUSTER", "DC_WORKER_IN_PROCESS"]

# Jobs run at once per worker. Handlers are I/O-bound, and the store's lease keeps events from being taken twice.
CONCURRENCY = 5

# How long a webhook waits for Redis to accept a job before answering 503.
ADD_TIMEOUT_SECONDS = 10


def validate(env: Mapping[str, str]) -> list[BootProblem]:
    """Checks the Redis address, and that it is not a cluster (see the module docstring).

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    problems = validate_redis(env, "DC_WEBHOOKS=bullmq")
    if not problems and redis_cluster(env):
        problems.append(
            problem(
                "bullmq_cluster_unsupported",
                "The Python server cannot run DC_WEBHOOKS=bullmq against a Redis cluster (DC_REDIS_CLUSTER=on).",
                "The BullMQ package for Python cannot take a cluster client. Set DC_WEBHOOKS=store (events are "
                "still held in the store), or use DC_WEBHOOKS=sqs on AWS, or run the Node server, which supports it.",
            )
        )
    return problems


class BullmqDispatcher:
    """A BullMQ queue and, optionally, its worker, run on a background event loop."""

    visible_delay_ms = 120000

    def __init__(self, config: Any, env: Mapping[str, str], processor: Any, log: Any):
        """Prepares the dispatcher; nothing connects until ``start()``.

        Args:
            config: The loaded config (site id, attempts, worker setting).
            env: The merged environment, for the Redis address.
            processor: The processor that runs handlers.
            log: The redacting logger.
        """
        self._config = config
        self._url = redis_url(env)
        self._env = env
        self._prefix = bullmq_prefix(config)
        self._processor = processor
        self._log = log
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._queue: Any = None
        self._worker: Any = None
        self._last_error: str | None = None
        self._active = 0

    def start(self) -> None:
        """Checks Redis, opens the queue and (unless ``DC_WORKER_IN_PROCESS=off``) the worker. Safe to call twice."""
        if self._loop is not None:
            return
        self._check_eviction()
        loop = asyncio.new_event_loop()
        self._loop = loop
        self._thread = threading.Thread(target=loop.run_forever, name="starter-crm-bullmq", daemon=True)
        self._thread.start()
        self._call(self._open())

    def _check_eviction(self) -> None:
        """Refuses a Redis that may evict keys, which would lose queued jobs.

        Raises:
            RuntimeError: When ``maxmemory-policy`` is not ``noeviction``.
        """
        probe = connect_redis(self._env)
        try:
            try:
                info = probe.config_get("maxmemory-policy")
            except Exception:  # noqa: BLE001 - managed services forbid CONFIG and run noeviction themselves
                return
            policy = info.get("maxmemory-policy") if isinstance(info, dict) else None
            if policy and policy != "noeviction":
                raise RuntimeError(
                    'Redis maxmemory-policy is "' + policy + '", but BullMQ needs "noeviction" or it can lose jobs. '
                    "Set maxmemory-policy noeviction on the Redis server."
                )
        finally:
            probe.close()

    def _call(self, coroutine: Any, timeout: float = 30) -> Any:
        """Runs a coroutine on the background loop and waits for its result.

        Args:
            coroutine: The coroutine to run.
            timeout: Seconds to wait.

        Returns:
            What the coroutine returned.
        """
        return asyncio.run_coroutine_threadsafe(coroutine, self._loop).result(timeout)

    async def _open(self) -> None:
        """Creates the queue and the worker on the background loop."""
        from bullmq import Queue, UnrecoverableError, Worker

        self._queue = Queue(QUEUE_NAME, {"connection": self._url, "prefix": self._prefix})
        if not self._config.events.worker_in_process:
            return

        async def process(job: Any, token: Any = None) -> str:
            """Runs one job: the processor reads the event from the store and runs its handlers."""
            self._active += 1
            try:
                result = await asyncio.get_running_loop().run_in_executor(
                    None, self._processor.process, job.data["event_id"]
                )
            finally:
                self._active -= 1
            if result["outcome"] == "retry":
                raise RuntimeError(result.get("error") or "handler failed")
            if result["outcome"] == "failed":
                raise UnrecoverableError(result.get("error") or "handler failed")
            return result["outcome"]

        self._worker = Worker(
            QUEUE_NAME, process, {"connection": self._url, "prefix": self._prefix, "concurrency": CONCURRENCY}
        )
        self._worker.on("error", lambda err: setattr(self, "_last_error", str(err)))

    async def _add(self, event_id: str) -> None:
        """Adds a job for an event, first clearing a finished job with the same id.

        Args:
            event_id: The recorded event.
        """
        # A finished job with this id would make add() a no-op, so clear it before a replay or a redelivery.
        existing = await self._queue.getJob(event_id)
        if existing is not None:
            state = await existing.getState()
            if state in ("completed", "failed"):
                await existing.remove()
        await self._queue.add(
            "webhook",
            {"event_id": event_id, "site_id": self._config.site_id or "default"},
            {
                "jobId": event_id,
                "attempts": self._config.events.max_attempts,
                "backoff": {"type": "exponential", "delay": 1000},
                "removeOnComplete": {"age": 3600, "count": 1000},
            },
        )

    def dispatch(self, event_id: str) -> dict:
        """Queues an event's id, waiting until Redis has accepted the job.

        Args:
            event_id: The recorded event.

        Returns:
            ``{"outcome": "queued"}``.

        Raises:
            Exception: When Redis does not accept the job; the webhook then answers 503.
        """
        self._call(self._add(event_id), ADD_TIMEOUT_SECONDS)
        return {"outcome": "queued"}

    def sweep(self, event_ids: list[str]) -> None:
        """Queues events no worker has finished (a crash, a flushed Redis).

        Args:
            event_ids: The stale events.
        """
        for event_id in event_ids:
            self.dispatch(event_id)

    def stop(self) -> None:
        """Lets the jobs in hand finish, then closes the worker, the queue and the loop."""
        if self._loop is None:
            return
        self._call(self._close(), 60)
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=5)
        self._loop = None
        self._thread = None

    async def _close(self) -> None:
        """Waits for the jobs in hand, then closes the worker and the queue on the background loop.

        BullMQ for Python's graceful ``close()`` cancels the worker's idle blocking read and then waits on
        it, and that wait can last indefinitely (the cancelled Redis call does not always finish). So the
        jobs in hand are awaited here, up to the shutdown grace period, and the worker is then closed with
        ``force``, which drops its connections instead of waiting on the idle read. A job still running
        after the grace period is cancelled; its event stays ``received`` and its lease runs out, so another
        worker runs it again (handlers already run at least once).
        """
        if self._worker is not None:
            loop = asyncio.get_running_loop()
            deadline = loop.time() + max(1, self._config.shutdown_grace_seconds - 2)
            while self._active > 0 and loop.time() < deadline:
                await asyncio.sleep(0.05)
            await self._worker.close(force=True)
            self._worker = None
        if self._queue is not None:
            await self._queue.close()
            self._queue = None

    def ready(self) -> bool:
        """Whether Redis answers and the worker reported no error.

        Returns:
            False when not started, unreachable or the worker is in error.
        """
        if self._queue is None or self._loop is None:
            return False
        try:
            return self._last_error is None and bool(self._call(self._ping(), 5))
        except Exception:  # noqa: BLE001 - any failure means not ready
            return False

    async def _ping(self) -> bool:
        """Pings Redis through the queue's connection."""
        return bool(await self._queue.client.ping())


def create(ctx: Any) -> BullmqDispatcher:
    """Creates the dispatcher.

    Args:
        ctx: The provider context (``config``, ``env``, ``processor``, ``log``).

    Returns:
        The dispatcher instance.
    """
    return BullmqDispatcher(ctx.config, ctx.env, ctx.processor, ctx.log)
