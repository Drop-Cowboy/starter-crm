"""The rate limiter's windows and the token cache's margin and bound."""

from __future__ import annotations

from starter_crm.providers.ratelimit import off
from starter_crm.providers.ratelimit.memory import MemoryLimiter
from starter_crm.token_cache import CACHE_MARGIN_MS, MAX_ENTRIES, TokenCache


class Clock:
    def __init__(self, start: float):
        self.now = start

    def __call__(self) -> float:
        return self.now


def test_a_window_resets_after_its_length():
    clock = Clock(1000.0)
    limiter = MemoryLimiter(now=clock)
    assert [limiter.hit("a", 1, 60)["allowed"] for _ in range(2)] == [True, False]
    clock.now += 61
    assert limiter.hit("a", 1, 60)["allowed"] is True


def test_the_refusal_carries_an_integer_retry_after_of_at_least_one():
    clock = Clock(1000.0)
    limiter = MemoryLimiter(now=clock)
    limiter.hit("a", 1, 60)
    clock.now += 59.9
    refused = limiter.hit("a", 1, 60)
    assert refused["allowed"] is False
    assert isinstance(refused["retry_after_seconds"], int)
    assert refused["retry_after_seconds"] >= 1


def test_the_off_limiter_never_refuses():
    limiter = off.create(None)
    assert all(limiter.hit("a", 1, 60)["allowed"] for _ in range(5))


def test_the_cache_serves_a_token_until_the_margin():
    clock = Clock(0)
    cache = TokenCache(now_ms=clock)
    cache.set("user|purpose", {"token": "t", "expires_at": CACHE_MARGIN_MS + 5000})
    assert cache.get("user|purpose")["token"] == "t"
    clock.now = 5000
    assert cache.get("user|purpose") is None


def test_the_cache_does_not_store_a_token_already_inside_the_margin():
    cache = TokenCache(now_ms=Clock(0))
    cache.set("k", {"token": "t", "expires_at": CACHE_MARGIN_MS})
    assert cache.get("k") is None


def test_the_cache_drops_the_oldest_entries_beyond_its_bound():
    cache = TokenCache(now_ms=Clock(0))
    for index in range(MAX_ENTRIES + 5):
        cache.set(str(index), {"token": "t", "expires_at": 10 * CACHE_MARGIN_MS})
    assert cache.get("0") is None
    assert cache.get(str(MAX_ENTRIES + 4)) is not None
