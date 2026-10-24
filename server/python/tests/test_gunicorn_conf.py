"""The production gunicorn settings that the container conformance run depends on.

Where it sits: ``gunicorn.conf.py`` is read by ``gunicorn -c`` in the Python
image. These tests load it as gunicorn does and pin the three choices that were
found by running the shared conformance suite against the built image: no
access log (it prints query strings, and a site token can be in one), the app
loaded once before workers fork (a bad config then exits the container), and
one worker by default (the built-in event store is per process).
"""

from __future__ import annotations

import runpy
from pathlib import Path

CONF = Path(__file__).resolve().parents[1] / "gunicorn.conf.py"


def load(monkeypatch, **env):
    """Loads gunicorn.conf.py with only the given environment settings."""
    for name in ("HOST", "PORT", "WEB_CONCURRENCY", "GUNICORN_THREADS", "DC_SHUTDOWN_GRACE_SECONDS"):
        monkeypatch.delenv(name, raising=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    return runpy.run_path(str(CONF))


def test_access_log_is_off_so_query_string_tokens_are_never_logged(monkeypatch):
    assert load(monkeypatch)["accesslog"] is None


def test_the_app_is_loaded_before_workers_fork(monkeypatch):
    assert load(monkeypatch)["preload_app"] is True


def test_one_worker_by_default_and_the_environment_can_raise_it(monkeypatch):
    assert load(monkeypatch)["workers"] == 1
    assert load(monkeypatch, WEB_CONCURRENCY="3")["workers"] == 3


def test_binds_where_host_and_port_say(monkeypatch):
    assert load(monkeypatch, HOST="0.0.0.0", PORT="9000")["bind"] == "0.0.0.0:9000"


def test_graceful_timeout_follows_the_shutdown_grace_setting(monkeypatch):
    conf = load(monkeypatch, DC_SHUTDOWN_GRACE_SECONDS="7")
    assert conf["graceful_timeout"] == 7
    assert conf["timeout"] >= 27


def test_the_drain_hooks_are_defined(monkeypatch):
    conf = load(monkeypatch)
    assert callable(conf["post_worker_init"])
    assert callable(conf["worker_int"])
