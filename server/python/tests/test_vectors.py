"""The vectors Node and Python share, so the two servers agree on the details that are easy to get subtly wrong."""

from __future__ import annotations

import uuid

import pytest

from starter_crm.log import redact
from starter_crm.provider_check import VECTORS
from starter_crm.providers.ratelimit.memory import MemoryLimiter


@pytest.mark.parametrize("vector", VECTORS["uuidv5"], ids=lambda v: v["name"])
def test_uuid_v5_matches_the_shared_vectors(vector):
    assert str(uuid.uuid5(uuid.UUID(vector["namespace"]), vector["name"])) == vector["expect"]


@pytest.mark.parametrize("vector", VECTORS["redaction"], ids=lambda v: v["input"][:30])
def test_redaction_matches_the_shared_vectors(vector):
    assert redact(vector["input"], vector["secrets"]) == vector["expect"]


def test_the_memory_limiter_follows_the_shared_sequence():
    spec = VECTORS["ratelimit"]
    limiter = MemoryLimiter()
    seen = [limiter.hit(spec["key"], spec["limit"], spec["windowSeconds"])["allowed"] for _ in spec["sequence"]]
    assert seen == spec["sequence"]
    assert limiter.hit(spec["otherKey"], spec["limit"], spec["windowSeconds"])["allowed"] is True
