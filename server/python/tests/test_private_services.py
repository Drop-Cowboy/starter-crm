"""Plain connections to Redis and Postgres in production, and boot problems that several providers share."""

from __future__ import annotations

import pytest
from helpers import API_KEY, API_SECRET, SITE_ID, WEBHOOK_SECRET

from starter_crm.bootstrap import bootstrap
from starter_crm.providers.store.postgres import validate as validate_postgres
from starter_crm.redis_util import validate_redis

PRODUCTION = {"DC_ENV": "production"}
REMOTE_REDIS = {"DC_REDIS_URL": "redis://redis.example.net:6379"}
REMOTE_POSTGRES = {"DC_DATABASE_URL": "postgres://u:p@db.example.net:5432/d"}


def codes(problems):
    return [item.code for item in problems]


def test_refuses_a_remote_redis_address_without_tls():
    assert codes(validate_redis({**PRODUCTION, **REMOTE_REDIS}, "DC_STORE=redis")) == ["insecure_redis_url"]


def test_accepts_tls_a_local_host_and_development():
    assert validate_redis({**PRODUCTION, "DC_REDIS_URL": "rediss://cache.example.com:6379"}, "x") == []
    assert validate_redis({**PRODUCTION, "DC_REDIS_URL": "redis://localhost:6379"}, "x") == []
    assert validate_redis(REMOTE_REDIS, "x") == []


@pytest.mark.parametrize("value", ["on", "1", "true", "ON"])
def test_accepts_a_remote_redis_when_the_operator_opts_in(value):
    assert validate_redis({**PRODUCTION, **REMOTE_REDIS, "DC_INSECURE_PRIVATE_SERVICES": value}, "x") == []


def test_other_values_are_not_consent():
    assert len(validate_redis({**PRODUCTION, **REMOTE_REDIS, "DC_INSECURE_PRIVATE_SERVICES": "off"}, "x")) == 1


def test_postgres_needs_sslmode_or_the_opt_in():
    assert codes(validate_postgres({**PRODUCTION, **REMOTE_POSTGRES})) == ["insecure_database_url"]
    secure = {**PRODUCTION, "DC_DATABASE_URL": REMOTE_POSTGRES["DC_DATABASE_URL"] + "?sslmode=require"}
    assert validate_postgres(secure) == []
    assert validate_postgres({**PRODUCTION, **REMOTE_POSTGRES, "DC_INSECURE_PRIVATE_SERVICES": "on"}) == []


def test_a_problem_shared_by_several_providers_is_reported_once(tmp_path):
    booted = bootstrap(
        {
            "DC_AUTH_MODE": "server",
            "DROPCOWBOY_API_KEY": API_KEY,
            "DROPCOWBOY_API_SECRET": API_SECRET,
            "DROPCOWBOY_SITE_ID": SITE_ID,
            "DROPCOWBOY_WEBHOOK_SECRET": WEBHOOK_SECRET,
            "DC_ENV": "production",
            "DC_IDENTITY": "passcode",
            "DC_PASSCODE": "a-long-enough-passcode",
            "DC_STORE": "redis",
            "DC_FANOUT": "redis",
            "DC_RATE_LIMIT": "redis",
            "DC_DATA": "sqlite",
            **REMOTE_REDIS,
        },
        tmp_path,
    )
    assert codes(booted.problems) == ["insecure_redis_url"]
