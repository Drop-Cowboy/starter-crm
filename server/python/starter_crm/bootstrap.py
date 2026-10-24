"""Boots the server's configuration and providers, in a fixed order.

Where it sits: ``__main__`` and ``wsgi`` call ``bootstrap()`` instead of
``load_config()`` directly. It finds each provider module, lets the secrets
provider fill in secrets *before* configuration is parsed (so a vault can
supply ``DROPCOWBOY_API_KEY``), loads and validates the config, validates each
provider's own settings, and only then creates the instances.

CONTRACT.md: "Boot" and "Providers".
What a customer changes: nothing.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import Config, is_provider_path, load_config, secret_values
from .handlers import load_handlers
from .log import Logger
from .module_runtime import ModuleRuntime, load_modules
from .problems import BootProblem, problem
from .processor import Processor
from .providers import (
    BUILTINS,
    KIND_DEFAULTS,
    KIND_VARIABLES,
    REQUIRED_METHODS,
    ProviderContext,
    resolve_provider,
)
from .redis_util import redis_url
from .runtime import Runtime
from .secrets_refresh import SecretsRuntime

# A provider setting whose name says it holds a credential, such as DOPPLER_TOKEN or VAULT_SECRET_ID.
CREDENTIAL_SETTING = re.compile(r"TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL")

# The secrets this server itself reads, asked of the provider alongside every chosen provider's config_keys.
SECRET_NAMES = (
    "DROPCOWBOY_API_KEY",
    "DROPCOWBOY_API_SECRET",
    "DROPCOWBOY_WEBHOOK_SECRET",
    "DC_PASSCODE",
    "DC_DATABASE_URL",
    "DC_REDIS_URL",
    "QSTASH_TOKEN",
    "QSTASH_CURRENT_SIGNING_KEY",
    "QSTASH_NEXT_SIGNING_KEY",
)

# The kinds whose default depends on other settings (a Redis address makes the store, fan-out and webhook mode
# default to Redis-backed ones; the data provider follows the store), so config.py decides which one to use and
# bootstrap loads it afterwards.
LATE_KINDS = ("store", "fanout", "webhooks", "data")


@dataclass
class Booted:
    """What ``bootstrap()`` returns.

    Attributes:
        problems: Every reason the server cannot start; empty on success.
        config: The loaded config (None when there are problems).
        log: The redacting logger.
        identity: The identity instance (server mode only).
        ratelimit: The rate limiter instance.
        observer: The observer instance, or None.
        secrets: The refresh runtime, or None when the provider cannot refresh or refreshing is off.
        runtime: The event runtime (store, fan-out, processor, webhook mode); created, not started.
    """

    problems: list[BootProblem] = field(default_factory=list)
    config: Config | None = None
    log: Logger | None = None
    identity: Any = None
    ratelimit: Any = None
    observer: Any = None
    secrets: SecretsRuntime | None = None
    runtime: Runtime | None = None


def _read(env: Mapping[str, str], name: str) -> str | None:
    value = env.get(name)
    value = value.strip() if isinstance(value, str) else ""
    return value or None


def _as_problem(item: Any) -> BootProblem:
    """Makes sure a provider's problem is a complete boot problem (a dict or a BootProblem)."""
    if isinstance(item, BootProblem):
        return item
    data = item if isinstance(item, dict) else {}
    code = data.get("code") if isinstance(data.get("code"), str) else "invalid_provider"
    message = data.get("message") if isinstance(data.get("message"), str) else "A provider reported a problem."
    fix = data.get("fix") if isinstance(data.get("fix"), str) else "See the provider's documentation."
    return problem(code, message, fix)


def _safe_validate(module: Any, env: Mapping[str, str]) -> list[BootProblem]:
    """Runs a provider's ``validate()``, turning a crash into a boot problem."""
    try:
        result = module.validate(env)
    except Exception as err:  # noqa: BLE001 - a customer's provider may raise anything
        return [
            problem(
                "invalid_provider",
                "Provider "
                + module.name
                + " crashed while checking its settings: "
                + (str(err) or err.__class__.__name__)
                + ".",
                "Fix the provider, then restart.",
            )
        ]
    return [_as_problem(item) for item in result] if isinstance(result, list) else []


def bootstrap(env: Mapping[str, str], root: Path) -> Booted:
    """Boots the configuration and providers.

    Args:
        env: The environment, after ``.env`` has been merged in.
        root: The starter root.

    Returns:
        ``Booted`` with every problem found, or with the config and created instances.
    """
    problems: list[BootProblem] = []
    known_secrets: set[str] = set()
    early_json = _read(env, "DC_LOG_FORMAT") == "json" or (
        not _read(env, "DC_LOG_FORMAT") and _read(env, "DC_ENV") == "production"
    )
    early_log = Logger(lambda: known_secrets, fmt="json" if early_json else "pretty")

    # 1. The modules. A value that is neither a built-in nor a path is left for load_config() to report.
    modules: dict[str, Any] = {}
    for kind, variable in KIND_VARIABLES.items():
        if kind in LATE_KINDS:
            continue
        spec = _read(env, variable) or ("redis" if kind == "ratelimit" and redis_url(env) else KIND_DEFAULTS[kind])
        usable = spec is None or is_provider_path(spec) or spec in BUILTINS[kind]
        if not usable:
            continue
        module, bad = resolve_provider(kind, spec, root)
        if bad is not None:
            problems.append(bad)
        modules[kind] = module

    # 2. Secrets, before anything reads them. Failing early here means a missing secret is reported by name below.
    secrets_instance = None
    merged_env: dict[str, str] = dict(env)
    if modules.get("secrets") is not None:
        secret_problems = _safe_validate(modules["secrets"], env)
        if secret_problems:
            return Booted(problems=[*problems, *secret_problems])
        # The provider's own credentials come from the environment, before anything is loaded.
        # Redacting them from the first log line means an error from the manager can never echo one.
        for key in modules["secrets"].config_keys:
            if CREDENTIAL_SETTING.search(key) and _read(env, key):
                known_secrets.add(_read(env, key))
        try:
            secrets_instance = modules["secrets"].create(ProviderContext(None, env, early_log, root))
            names = set(SECRET_NAMES)
            for kind in ("identity", "ratelimit", "log", "observer"):
                if modules.get(kind) is not None:
                    names.update(modules[kind].config_keys)
            loaded = secrets_instance.load(sorted(names)) or {}
            for key, value in loaded.items():
                if isinstance(value, str) and value != "":
                    merged_env[key] = value
                    known_secrets.add(value)
        except Exception as err:  # noqa: BLE001 - a customer's provider may raise anything
            return Booted(
                problems=[
                    *problems,
                    problem(
                        "secret_load_failed",
                        "The secrets provider "
                        + modules["secrets"].name
                        + " could not load secrets: "
                        + (str(err) or err.__class__.__name__)
                        + ".",
                        "Check the provider's settings and credentials. No secret value is shown here.",
                    ),
                ]
            )

    # 3. Config, then each provider's own settings.
    config, config_problems = load_config(merged_env, root)
    config.known_secrets = known_secrets
    problems.extend(config_problems)
    # A Redis address that arrived from the secrets provider can still turn the rate limiter to Redis.
    limiter_module = modules.get("ratelimit")
    if (
        not config_problems
        and not is_provider_path(config.rate_limit)
        and limiter_module is not None
        and limiter_module.name != config.rate_limit
    ):
        limiter_module, bad = resolve_provider("ratelimit", config.rate_limit, root)
        if bad is not None:
            problems.append(bad)
        modules["ratelimit"] = limiter_module
    # The event providers are named by config.events, which has already worked out the defaults and combinations.
    if not config_problems:
        for kind in LATE_KINDS:
            spec = config.data.provider if kind == "data" else getattr(config.events, kind)
            module, bad = resolve_provider(kind, spec, root)
            if bad is not None:
                problems.append(bad)
            modules[kind] = module
    for kind in ("identity", "ratelimit", "log", "observer", *LATE_KINDS):
        # Identity only matters in server mode; elsewhere a stray DC_IDENTITY is already reported.
        if modules.get(kind) is None or (kind == "identity" and config.mode != "server"):
            continue
        # Several providers can report the same thing (for example the Redis address), and it is one problem.
        for found in _safe_validate(modules[kind], merged_env):
            if not any(seen.code == found.code and seen.message == found.message for seen in problems):
                problems.append(found)
    handlers, handlers_problem = load_handlers(config)
    if handlers_problem:
        problems.append(
            problem(
                "invalid_webhook_handlers",
                "DC_WEBHOOK_HANDLERS (" + str(config.events.handlers_path) + ") " + handlers_problem + ".",
                "Fix the file, or unset DC_WEBHOOK_HANDLERS. See starter_crm/handlers.py for the shape.",
            )
        )
    # Modules need a signed-in user, so only server mode runs them.
    loaded_modules: list[Any] = []
    if config.mode == "server":
        loaded_modules, modules_problem = load_modules()
        if modules_problem:
            problems.append(
                problem(
                    "invalid_module",
                    "The modules folder is broken: " + modules_problem + ".",
                    "Fix or remove that file under server/python/starter_crm/modules/. "
                    'See CUSTOMIZE.md, "Add a module".',
                )
            )
    if problems:
        return Booted(problems=problems)

    # 4. Create the instances.
    def created(kind: str, module: Any, store: Any = None, processor: Any = None):
        context = ProviderContext(config, merged_env, early_log, root, store=store, processor=processor)
        try:
            instance = module.create(context)
        except Exception as err:  # noqa: BLE001 - a customer's provider may raise anything
            problems.append(
                problem(
                    "invalid_provider",
                    kind
                    + " provider "
                    + module.name
                    + " failed to start: "
                    + (str(err) or err.__class__.__name__)
                    + ".",
                    "Check its settings and see docs/providers/" + kind + ".md.",
                )
            )
            return None
        missing = next(
            (method for method in REQUIRED_METHODS[kind] if not callable(getattr(instance, method, None))), None
        )
        if missing:
            problems.append(
                problem(
                    "invalid_provider",
                    kind + " provider " + module.name + " did not return an object with a " + missing + "() method.",
                    "See docs/providers/" + kind + ".md for the shape.",
                )
            )
            return None
        return instance

    log_sink = created("log", modules["log"])
    ratelimit = created("ratelimit", modules["ratelimit"])
    observer = created("observer", modules["observer"]) if modules.get("observer") is not None else None
    identity = created("identity", modules["identity"]) if config.mode == "server" else None
    if problems:
        return Booted(problems=problems)

    log = Logger(lambda: secret_values(config), sink=log_sink)
    event_store = created("store", modules["store"])
    event_data = created("data", modules["data"])
    module_runtime = None
    if event_data is not None:
        try:
            module_runtime = ModuleRuntime(loaded_modules, event_data, config, log)
        except Exception as err:  # noqa: BLE001 - a module's routes() may raise anything
            problems.append(
                problem(
                    "invalid_module",
                    "A module could not be set up: " + (str(err) or err.__class__.__name__) + ".",
                    'Fix the module under server/python/starter_crm/modules/. See CUSTOMIZE.md, "Add a module".',
                )
            )
    event_fanout = created("fanout", modules["fanout"], store=event_store) if event_store is not None else None
    event_processor = None
    event_dispatcher = None
    if event_store is not None and event_fanout is not None and module_runtime is not None:
        event_processor = Processor(
            config, event_store, event_fanout, handlers, log, on_event=module_runtime.run_event_hooks
        )
        event_dispatcher = created("webhooks", modules["webhooks"], store=event_store, processor=event_processor)
    if problems:
        return Booted(problems=problems)
    event_runtime = Runtime(
        config,
        event_store,
        event_fanout,
        event_dispatcher,
        event_processor,
        log,
        data=event_data,
        modules=module_runtime,
    )
    secrets_runtime = None
    if (
        secrets_instance is not None
        and callable(getattr(secrets_instance, "refresh", None))
        and config.secrets.refresh_seconds > 0
    ):
        secrets_runtime = SecretsRuntime(config, secrets_instance, log, config.secrets.refresh_seconds)
    return Booted(
        problems=[],
        config=config,
        log=log,
        identity=identity,
        ratelimit=ratelimit,
        observer=observer,
        secrets=secrets_runtime,
        runtime=event_runtime,
    )
