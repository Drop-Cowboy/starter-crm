"""Event settings resolve to the same values and problems as the Node server, from the shared fixture."""

from __future__ import annotations

import json

import pytest

from starter_crm.config import load_config
from starter_crm.provider_check import STARTER_ROOT

FIXTURE = json.loads(
    (STARTER_ROOT / "server" / "conformance" / "provider" / "events-config.json").read_text(encoding="utf-8")
)


def summarize(events):
    if events is None:
        return None
    return {
        "store": events.store,
        "fanout": events.fanout,
        "webhooks": events.webhooks,
        "retention": events.retention_hours,
        "stream": events.max_stream_seconds,
        "keepalive": events.keepalive_seconds,
        "fpoll": events.fanout_poll_ms,
        "opoll": events.outbox_poll_ms,
        "attempts": events.max_attempts,
        "budget": events.handler_budget_ms,
        "handlers": events.handlers_path,
        "worker": events.worker_in_process,
        "sqlite": events.sqlite_path,
    }


@pytest.mark.parametrize("entry", FIXTURE["cases"], ids=lambda entry: json.dumps(entry["env"]))
def test_resolves_like_the_shared_fixture(entry):
    config, problems = load_config({**FIXTURE["base"], **entry["env"]}, "/nonexistent")
    assert sorted(item.code for item in problems) == entry["codes"]
    assert summarize(getattr(config, "events", None)) == entry["events"]
    assert config.data.provider == entry["data"]
