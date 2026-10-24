"""Reads are retried a bounded number of times; mints and writes never are; the token cache saves calls."""

from __future__ import annotations

import time

import pytest
from helpers import json_answer, make_booted_client, make_config

from starter_crm import upstream
from starter_crm.errors import HttpError
from starter_crm.upstream import call_dropcowboy


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(upstream.time, "sleep", lambda seconds: None)


def answers(*statuses, headers=None):
    queue = list(statuses)

    def respond(call):
        status = queue.pop(0) if len(queue) > 1 else queue[0]
        return json_answer(status, {"data": {"ok": True}} if status == 200 else {"message": "no"}, headers)

    return respond


def test_a_get_is_retried_after_a_5xx_and_then_succeeds(upstream):
    upstream.respond = answers(503, 502, 200)
    result = call_dropcowboy(make_config(DROPCOWBOY_API_BASE=upstream.url), "GET", "/x")
    assert result == {"data": {"ok": True}}
    assert len(upstream.calls) == 3


def test_a_get_gives_up_after_three_attempts_in_total(upstream):
    upstream.respond = answers(503)
    with pytest.raises(HttpError):
        call_dropcowboy(make_config(DROPCOWBOY_API_BASE=upstream.url), "GET", "/x")
    assert len(upstream.calls) == 3


def test_a_429_with_a_short_retry_after_is_retried_and_a_long_one_is_not(upstream):
    upstream.respond = answers(429, 200, headers={"Retry-After": "1"})
    call_dropcowboy(make_config(DROPCOWBOY_API_BASE=upstream.url), "GET", "/x")
    assert len(upstream.calls) == 2
    upstream.calls.clear()
    upstream.respond = answers(429, headers={"Retry-After": "30"})
    with pytest.raises(HttpError) as raised:
        call_dropcowboy(make_config(DROPCOWBOY_API_BASE=upstream.url), "GET", "/x")
    assert raised.value.status == 429
    assert len(upstream.calls) == 1


def test_a_4xx_is_never_retried(upstream):
    upstream.respond = answers(404)
    with pytest.raises(HttpError):
        call_dropcowboy(make_config(DROPCOWBOY_API_BASE=upstream.url), "GET", "/x")
    assert len(upstream.calls) == 1


def test_a_post_is_never_retried(upstream):
    upstream.respond = answers(503)
    with pytest.raises(HttpError):
        call_dropcowboy(make_config(DROPCOWBOY_API_BASE=upstream.url), "POST", "/x", {"a": 1})
    assert len(upstream.calls) == 1


def test_a_cached_token_is_served_without_a_second_mint(tmp_path, upstream):
    upstream.respond = lambda call: json_answer(
        200, {"data": {"token": "minted-token-0001", "expires_at": int(time.time() * 1000) + 3_600_000}}
    )
    app, _ = make_booted_client(tmp_path, DROPCOWBOY_API_BASE=upstream.url, DC_TOKEN_CACHE="on")
    first = app.post("/api/dropcowboy/token", json={"purpose": "campaigns"})
    second = app.post("/api/dropcowboy/token", json={"purpose": "campaigns"})
    assert first.status_code == second.status_code == 200
    assert first.get_json() == second.get_json()
    assert len([call for call in upstream.calls if call["method"] == "POST"]) == 1


def test_the_cache_can_be_turned_off(tmp_path, upstream):
    upstream.respond = lambda call: json_answer(
        200, {"data": {"token": "minted-token-0001", "expires_at": int(time.time() * 1000) + 3_600_000}}
    )
    app, _ = make_booted_client(tmp_path, DROPCOWBOY_API_BASE=upstream.url, DC_TOKEN_CACHE="off")
    app.post("/api/dropcowboy/token", json={"purpose": "campaigns"})
    app.post("/api/dropcowboy/token", json={"purpose": "campaigns"})
    assert len([call for call in upstream.calls if call["method"] == "POST"]) == 2
