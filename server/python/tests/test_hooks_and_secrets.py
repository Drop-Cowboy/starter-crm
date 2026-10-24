"""Observer hooks never break a request; secrets refresh keeps the last good values."""

from __future__ import annotations

from helpers import make_config

from starter_crm.hooks import Hooks
from starter_crm.secrets_refresh import SecretsRuntime, apply_secrets


class Recorder:
    def __init__(self):
        self.lines = []

    def warn(self, message):
        self.lines.append(message)


class Observer:
    def __init__(self):
        self.seen = []

    def on_request(self, payload):
        self.seen.append(("on_request", payload))

    def on_webhook(self, payload):
        raise RuntimeError("observer failure")


def test_a_hook_receives_its_payload():
    observer = Observer()
    Hooks(observer, Recorder()).on_request({"request_id": "r"})
    assert observer.seen == [("on_request", {"request_id": "r"})]


def test_a_missing_hook_is_a_no_op():
    Hooks(Observer(), Recorder()).on_response({"request_id": "r"})
    Hooks(None, Recorder()).on_error({"request_id": "r"})


def test_a_throwing_hook_is_logged_by_its_contract_name_and_swallowed():
    log = Recorder()
    Hooks(Observer(), log).on_webhook({"request_id": "r"})
    assert log.lines == ["Observer hook onWebhook failed: observer failure"]


class Provider:
    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = 0

    def refresh(self):
        self.calls += 1
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def test_refresh_waits_for_the_interval_then_swaps_the_key():
    config = make_config()
    provider = Provider([{"DROPCOWBOY_API_KEY": "rotated-key-0009"}])
    clock = Clock()
    runtime = SecretsRuntime(config, provider, Recorder(), 300, now=clock)
    runtime.refresh_if_due()
    assert provider.calls == 0
    clock.now = 301
    runtime.refresh_if_due()
    assert provider.calls == 1
    assert config.api_key == "rotated-key-0009"
    assert "rotated-key-0009" in config.known_secrets


def test_a_failed_refresh_keeps_the_last_good_values_and_warns():
    config = make_config()
    before = config.api_key
    log = Recorder()
    clock = Clock()
    runtime = SecretsRuntime(config, Provider([RuntimeError("vault down")]), log, 10, now=clock)
    clock.now = 11
    runtime.refresh_if_due()
    assert config.api_key == before
    assert "vault down" in log.lines[0]


def test_an_interval_of_zero_never_refreshes():
    provider = Provider([{}])
    clock = Clock()
    runtime = SecretsRuntime(make_config(), provider, Recorder(), 0, now=clock)
    clock.now = 10_000
    runtime.refresh_if_due()
    assert provider.calls == 0


def test_a_comma_separated_webhook_secret_is_split_so_a_rotation_can_overlap():
    config = make_config()
    apply_secrets(config, {"DROPCOWBOY_WEBHOOK_SECRET": "new-one-0001, old-one-0002"})
    assert config.webhook_secrets == ["new-one-0001", "old-one-0002"]


def test_blank_values_are_ignored():
    config = make_config()
    before = (config.api_key, config.api_secret)
    apply_secrets(config, {"DROPCOWBOY_API_KEY": "  ", "DROPCOWBOY_API_SECRET": ""})
    assert (config.api_key, config.api_secret) == before
