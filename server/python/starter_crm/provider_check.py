"""The provider conformance checks for Python providers.

Where it sits: ``python -m starter_crm.provider_check <kind> <path>`` runs a
data-driven test that a provider file has the documented shape and behaves the
way the server relies on. The Node twin is ``npm run conformance:provider``;
both read the same vectors in ``server/conformance/provider/vectors.json``.
The unit tests also run it over every built-in. It loads the file the way the
server does, so a provider that passes here loads at boot.

CONTRACT.md: "Providers".
What a customer changes: nothing; run it on your own provider before you point
``DC_<KIND>`` at it. ``NAME=value`` arguments become settings the provider reads
(for example ``DC_PASSCODE=...``).
"""

from __future__ import annotations

import inspect
import json
import sys
import time
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from flask import Flask, request

from .config import is_provider_path, load_config
from .log import Logger
from .providers import (
    BUILTINS,
    HOOK_NAMES,
    REQUIRED_METHODS,
    ProviderContext,
    load_provider_file,
    shape_problem,
)

# starter-crm/server/python/starter_crm/provider_check.py -> starter-crm
STARTER_ROOT = Path(__file__).resolve().parents[3]

# The vectors both implementations share.
VECTORS: dict[str, Any] = json.loads(
    (STARTER_ROOT / "server" / "conformance" / "provider" / "vectors.json").read_text(encoding="utf-8")
)

# A site id, key and user id used only to build a throwaway config.
SAMPLE_ENV = {
    "DC_AUTH_MODE": "server",
    "DROPCOWBOY_API_KEY": "check-key-0001",
    "DROPCOWBOY_API_SECRET": "check-secret-0002",
    "DROPCOWBOY_SITE_ID": "3f8a2c1e-9b4d-4e7a-8c2f-1d5e6a7b8c9d",
    "DROPCOWBOY_WEBHOOK_SECRET": "check-webhook-secret-0003",
    "STARTER_CRM_USER_ID": "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
}

CheckResult = dict[str, Any]


class _Recorder:
    """Collects one result per named check."""

    def __init__(self) -> None:
        """Starts with no results."""
        self.results: list[CheckResult] = []

    def guard(self, name: str, check: Callable[[], None]) -> None:
        """Runs ``check`` and records whether it raised.

        Args:
            name: What the check proves, shown in the output.
            check: A function that raises on failure.
        """
        try:
            check()
        except Exception as err:  # noqa: BLE001 - any failure of a provider is a failed check, not a crash
            self.results.append({"name": name, "ok": False, "detail": str(err) or err.__class__.__name__})
            return
        self.results.append({"name": name, "ok": True})

    def fail(self, name: str, detail: str) -> None:
        """Records a failed check directly.

        Args:
            name: The check's name.
            detail: Why it failed.
        """
        self.results.append({"name": name, "ok": False, "detail": detail})

    def failed(self) -> bool:
        """Returns True once any check has failed."""
        return any(not item["ok"] for item in self.results)


def check_provider(kind: str, file: str | Path, env: Mapping[str, str] | None = None) -> list[CheckResult]:
    """Runs the checks on one provider file.

    Args:
        kind: ``identity``, ``secrets``, ``ratelimit``, ``log`` or ``observer``.
        file: Path to the provider module, or the name of a built-in (``passcode``).
        env: Extra settings the provider reads, such as ``DC_PASSCODE``.

    Returns:
        One ``{"name", "ok", "detail"?}`` dict per check.
    """
    rec = _Recorder()
    if kind not in REQUIRED_METHODS:
        rec.fail("kind", "kind must be one of " + ", ".join(REQUIRED_METHODS))
        return rec.results

    loaded: dict[str, Any] = {}

    def load() -> None:
        builtin = BUILTINS[kind].get(str(file))
        if builtin is not None and not is_provider_path(str(file)):
            loaded["module"] = builtin
            return
        module, error = load_provider_file(kind, Path(file).resolve())
        if error is not None:
            raise RuntimeError(error)
        loaded["module"] = module

    rec.guard("the file loads", load)
    if "module" not in loaded:
        return rec.results
    module = loaded["module"]

    def shape() -> None:
        wrong = shape_problem(module)
        if wrong:
            raise RuntimeError(wrong)

    rec.guard("defines name, config_keys, validate and create", shape)
    if rec.failed():
        return rec.results

    merged = {**SAMPLE_ENV, **(dict(env) if env else {})}

    def validate() -> None:
        problems = module.validate(merged)
        if not isinstance(problems, list):
            raise RuntimeError("validate must return a list (empty when fine)")
        for item in problems:
            code = item.get("code") if isinstance(item, dict) else getattr(item, "code", None)
            message = item.get("message") if isinstance(item, dict) else getattr(item, "message", None)
            if not isinstance(code, str) or not isinstance(message, str):
                raise RuntimeError("every problem needs a string code and message")

    rec.guard("validate(env) returns a list of problems with a code and a message", validate)

    created: dict[str, Any] = {}

    def create() -> None:
        config, problems = load_config(merged, STARTER_ROOT)
        if problems:
            raise RuntimeError("the sample configuration did not load: " + "; ".join(p.message for p in problems))
        log = Logger([], sink=_Discard())
        instance = module.create(ProviderContext(config=config, env=merged, log=log, root=STARTER_ROOT))
        if instance is None or isinstance(instance, (str, int, float, bool)):
            raise RuntimeError("create must return an object")
        for method in REQUIRED_METHODS[kind]:
            if not callable(getattr(instance, method, None)):
                raise RuntimeError("the instance needs a `" + method + "` method")
        if kind == "observer" and not any(callable(getattr(instance, hook, None)) for hook in HOOK_NAMES):
            raise RuntimeError("an observer needs at least one of " + ", ".join(HOOK_NAMES))
        created["instance"] = instance

    rec.guard("create(ctx) returns an instance with the methods the server calls", create)
    if "instance" not in created:
        return rec.results
    instance = created["instance"]

    if kind == "ratelimit":
        _ratelimit_checks(rec, instance, module)
    elif kind == "secrets":
        _secrets_checks(rec, instance, module)
    elif kind == "log":
        _log_checks(rec, instance)
    elif kind == "identity":
        _identity_checks(rec, instance, module)
    elif kind == "observer":
        _observer_checks(rec, instance)
    return rec.results


class _Discard:
    """A log sink that drops everything; a check does not need the lines."""

    def write(self, record: dict) -> None:
        """Ignores one record.

        Args:
            record: The log record (dropped).
        """


def _ratelimit_checks(rec: _Recorder, instance: Any, module: Any) -> None:
    """Checks a rate limiter against the shared sequence.

    Args:
        rec: Where results go.
        instance: The limiter.
        module: The module; ``never_limits = True`` marks one that deliberately allows everything.
    """
    spec = VECTORS["ratelimit"]
    if getattr(module, "never_limits", False) is True:

        def always() -> None:
            for _ in range(spec["limit"] + 2):
                if instance.hit(spec["key"], spec["limit"], spec["windowSeconds"])["allowed"] is not True:
                    raise RuntimeError("a never_limits limiter must always allow")

        rec.guard("hit() always allows (the module declares never_limits)", always)
        return

    def sequence() -> None:
        seen = []
        last: dict = {}
        for _ in spec["sequence"]:
            last = instance.hit(spec["key"], spec["limit"], spec["windowSeconds"])
            if not isinstance(last.get("allowed"), bool):
                raise RuntimeError("hit must return a dict with a boolean `allowed`")
            seen.append(last["allowed"])
        if seen != spec["sequence"]:
            raise RuntimeError("expected " + json.dumps(spec["sequence"]) + " but got " + json.dumps(seen))
        retry = last.get("retry_after_seconds")
        if isinstance(retry, bool) or not isinstance(retry, int) or retry < 1:
            raise RuntimeError("retry_after_seconds must be an integer of at least 1")
        remaining = last.get("remaining")
        if isinstance(remaining, bool) or not isinstance(remaining, (int, float)) or remaining < 0:
            raise RuntimeError("remaining must be a number of at least 0")

    rec.guard("hit() allows up to the limit, then refuses, with an integer retry_after_seconds of at least 1", sequence)

    def separate() -> None:
        if not instance.hit(spec["otherKey"], spec["limit"], spec["windowSeconds"])["allowed"]:
            raise RuntimeError("a different key must have its own window")

    rec.guard("keys are counted separately", separate)


def _secrets_checks(rec: _Recorder, instance: Any, module: Any) -> None:
    """Checks a secrets provider.

    Args:
        rec: Where results go.
        instance: The provider.
        module: The module (for ``test_vectors``).
    """
    absent = "STARTER_CRM_CHECK_ABSENT_NAME"

    def load() -> None:
        values = instance.load([absent])
        if not isinstance(values, dict):
            raise RuntimeError("load must return a dict")
        for value in values.values():
            if not isinstance(value, str):
                raise RuntimeError("every loaded value must be a string")
        if values.get(absent, "") != "":
            raise RuntimeError("a name the provider does not have must be left out")

    rec.guard("load(names) returns a dict of string values for the names it has", load)

    if callable(getattr(instance, "refresh", None)):

        def refresh() -> None:
            if not isinstance(instance.refresh(), dict):
                raise RuntimeError("refresh must return a dict")

        rec.guard("refresh() returns the same shape as load()", refresh)

    for vector in _vectors_of(module):

        def run(vector: dict = vector) -> None:
            values = instance.load(vector["names"])
            for name, expected in vector["expect"].items():
                if values.get(name) != expected:
                    raise RuntimeError(name + " was not the expected value")

        rec.guard("test_vectors: load(" + json.dumps(vector["names"]) + ")", run)


def _log_checks(rec: _Recorder, instance: Any) -> None:
    """Checks a log provider.

    Args:
        rec: Where results go.
        instance: The provider.
    """

    def write() -> None:
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        instance.write({"time": now, "level": "info", "message": "check line", "request_id": "check-request"})
        instance.write(
            {
                "time": now,
                "level": "info",
                "message": "GET /x 200 1ms",
                "request_id": "check-request",
                "method": "GET",
                "path": "/x",
                "status": 200,
                "duration_ms": 1,
            }
        )
        instance.write({"time": now, "level": "error", "message": "check error"})

    rec.guard("write(record) accepts an info line and an access line without throwing", write)


def _identity_checks(rec: _Recorder, instance: Any, module: Any) -> None:
    """Checks an identity provider.

    Args:
        rec: Where results go.
        instance: The provider.
        module: The module (for ``test_vectors``; ``always_signed_in = True`` marks the dev identity).
    """
    app = Flask("provider_check")

    def authenticate(headers: Mapping[str, str]) -> Any:
        with app.test_request_context("/api/contacts", headers=dict(headers)):
            return instance.authenticate(request)

    def anonymous() -> None:
        found = authenticate({})
        if getattr(module, "always_signed_in", False) is True:
            if not isinstance(found, dict) or not isinstance(found.get("id"), str):
                raise RuntimeError("an always_signed_in identity must return a user with a string id")
        elif found is not None:
            raise RuntimeError("with no credentials, return None (the server answers 401)")

    rec.guard("authenticate() with no credentials returns None (or, for always_signed_in, a user)", anonymous)

    def routes() -> None:
        if not callable(getattr(instance, "routes", None)):
            return
        entries = instance.routes()
        if not isinstance(entries, list):
            raise RuntimeError("routes() must return a list")
        for route in entries:
            if route.get("method") not in ("GET", "POST") or not isinstance(route.get("path"), str):
                raise RuntimeError("each route needs a GET or POST method, a path and a handler")
            if not callable(route.get("handler")):
                raise RuntimeError("each route needs a GET or POST method, a path and a handler")
            if not route["path"].startswith("/api/auth/"):
                raise RuntimeError("route paths must start with /api/auth/ (got " + route["path"] + ")")

    rec.guard("routes(), when present, returns method, path and handler entries under /api/auth/", routes)

    def challenge() -> None:
        value = getattr(instance, "challenge", None)
        if value is not None and not isinstance(value, str):
            raise RuntimeError('challenge must be a string such as "Bearer"')

    rec.guard("challenge, when present, is a string", challenge)

    for vector in _vectors_of(module):

        def run(vector: dict = vector) -> None:
            found = authenticate(vector.get("headers") or {})
            if vector["expect"] is None:
                if found is not None:
                    raise RuntimeError("expected no identity")
                return
            if not isinstance(found, dict) or not isinstance(found.get("id"), str):
                raise RuntimeError("expected an identity with a string id")
            for key, value in vector["expect"].items():
                if found.get(key) != value:
                    raise RuntimeError("expected " + key + " = " + str(value))

        rec.guard("test_vectors: " + str(vector.get("name") or json.dumps(vector.get("headers"))), run)


def _observer_checks(rec: _Recorder, instance: Any) -> None:
    """Checks an observer: every hook it has must accept a payload without raising.

    Args:
        rec: Where results go.
        instance: The observer.
    """
    base = {"request_id": "check-request", "method": "GET", "path": "/x"}
    payloads = {
        "on_request": {**base, "client_ip": "127.0.0.1"},
        "on_response": {**base, "status": 200, "duration_ms": 1},
        "on_error": {**base, "message": "check error"},
        "on_webhook": {
            "request_id": "check-request",
            "event_id": "d1f3a8e2-7c4b-4f9a-9d22-9c1e2f3a4b5c",
            "event": "check",
            "duplicate": False,
        },
        "on_token_minted": {
            "request_id": "check-request",
            "user_id": "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
            "purpose": "check",
            "cached": False,
            "expires_at": int(time.time() * 1000) + 3_600_000,
        },
    }
    for hook in HOOK_NAMES:
        method = getattr(instance, hook, None)
        if not callable(method):
            continue
        if inspect.iscoroutinefunction(method):
            rec.fail(hook + "(payload) is synchronous", "Python hooks are called synchronously; do not use async def")
            continue
        rec.guard(hook + "(payload) accepts the documented payload", lambda m=method, h=hook: m(payloads[h]))


def _vectors_of(module: Any) -> list[dict]:
    """Returns the module's optional ``test_vectors`` list, or an empty one.

    Args:
        module: The provider module.

    Returns:
        The vectors the author supplied.
    """
    vectors = getattr(module, "test_vectors", None)
    return vectors if isinstance(vectors, list) else []


def main(argv: list[str]) -> int:
    """Runs the checks from the command line and prints one line per check.

    Args:
        argv: ``[kind, path, NAME=value, ...]``.

    Returns:
        The process exit code: 0 when every check passed, 1 when one failed, 2 for bad arguments.
    """
    if len(argv) < 2:
        print(
            "Usage: python -m starter_crm.provider_check <identity|secrets|ratelimit|log|observer> "
            "<path-to-provider> [NAME=value ...]",
            file=sys.stderr,
        )
        return 2
    env: dict[str, str] = {}
    for setting in argv[2:]:
        name, sep, value = setting.partition("=")
        if not sep or not name:
            print('Settings look like NAME=value (got "' + setting + '").', file=sys.stderr)
            return 2
        env[name] = value
    results = check_provider(argv[0], argv[1], env)
    failed = 0
    for result in results:
        print(("ok     " if result["ok"] else "FAILED ") + result["name"])
        if not result["ok"]:
            print("         " + result["detail"])
            failed += 1
    print("\n" + str(len(results) - failed) + " of " + str(len(results)) + " checks passed.")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
