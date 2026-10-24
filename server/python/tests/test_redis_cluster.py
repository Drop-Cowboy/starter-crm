"""Redis in cluster mode (``DC_REDIS_CLUSTER=on``) against the single-node Valkey cluster in tests/services.compose.yml.

The store has its own cluster case in ``test_stores.py``; these cover the client, the fan-out, the rate limiter and the
settings. The suites skip, with a reason, when the cluster is not running. The Node server runs the same cases in
``server/node/test/redis-cluster.test.js``.
"""

from __future__ import annotations

import time
import uuid
from pathlib import Path

import pytest
from helpers import make_config, silent_logger
from services import HAVE_REDIS_CLUSTER, REDIS_CLUSTER_URL, fresh_site

from starter_crm.providers import ProviderContext
from starter_crm.providers.fanout import redis as redis_fanout
from starter_crm.providers.ratelimit import redis as redis_ratelimit
from starter_crm.providers.store import memory
from starter_crm.redis_util import connect_redis, redis_cluster, validate_redis

ENV = {"DC_REDIS_URL": REDIS_CLUSTER_URL, "DC_REDIS_CLUSTER": "on"}
STARTER_ROOT = Path(__file__).resolve().parents[3]


def until(check, seconds=8):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if check():
            return True
        time.sleep(0.05)
    return bool(check())


@pytest.mark.skipif(not HAVE_REDIS_CLUSTER, reason="Valkey cluster is not running")
class TestCluster:
    def test_connects_as_a_cluster_client(self):
        from redis.cluster import RedisCluster

        client = connect_redis(ENV)
        try:
            assert isinstance(client, RedisCluster)
            assert client.ping() is True
        finally:
            client.close()

    def test_delivers_a_published_event_id_to_a_subscriber_through_the_cluster(self):
        config = make_config(DROPCOWBOY_SITE_ID=fresh_site(), DC_STORE="memory")
        store = memory.create(ProviderContext(config, {}, silent_logger(), STARTER_ROOT))
        event_id = str(uuid.uuid4())
        store.record(
            {
                "event_id": event_id,
                "event": "contact.msg.received",
                "event_at": 1,
                "received_at": 2,
                "attempt": 1,
                "data": {},
            }
        )
        context = ProviderContext(config, ENV, silent_logger(), STARTER_ROOT, store=store)
        first, second = redis_fanout.create(context), redis_fanout.create(context)
        first.start()
        second.start()
        try:
            seen = []
            second.subscribe(lambda event: seen.append(event["event_id"]))
            first.publish({"event_id": event_id})
            assert until(lambda: event_id in seen)
            assert second.ready() is True
        finally:
            first.close()
            second.close()

    def test_counts_hits_in_the_rate_limiter_and_refuses_past_the_limit(self):
        config = make_config(DROPCOWBOY_SITE_ID=fresh_site())
        limiter = redis_ratelimit.create(ProviderContext(config, ENV, silent_logger(), STARTER_ROOT))
        key = str(uuid.uuid4())
        assert [limiter.hit(key, 3, 60)["allowed"] for _ in range(4)] == [True, True, True, False]


class TestSettings:
    def test_reads_on_1_and_true_as_cluster_mode_and_anything_else_as_off(self):
        for value in ("on", "ON", "1", "true"):
            assert redis_cluster({"DC_REDIS_CLUSTER": value}) is True
        for value in (None, "", "off", "0", "false"):
            assert redis_cluster({"DC_REDIS_CLUSTER": value} if value is not None else {}) is False

    def test_rejects_a_value_that_is_not_on_or_off(self):
        base = {"DC_REDIS_URL": "redis://localhost:6379"}
        assert [p.code for p in validate_redis({**base, "DC_REDIS_CLUSTER": "maybe"}, "x")] == ["invalid_redis_cluster"]
        assert validate_redis({**base, "DC_REDIS_CLUSTER": "on"}, "x") == []

    def test_bullmq_refuses_a_cluster_with_the_fix_in_the_message(self):
        from starter_crm.providers.webhooks import bullmq

        problems = bullmq.validate({"DC_REDIS_URL": "redis://localhost:6379", "DC_REDIS_CLUSTER": "on"})
        assert [p.code for p in problems] == ["bullmq_cluster_unsupported"]
        assert "DC_WEBHOOKS=store" in problems[0].fix
        assert bullmq.validate({"DC_REDIS_URL": "redis://localhost:6379"}) == []
