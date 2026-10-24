"""The provider registry and loader.

Where it sits: ``bootstrap`` asks ``resolve_provider()`` for the module behind
each ``DC_<KIND>`` setting. A value is either a built-in name or a relative
path to your own ``.py`` file; both must export the same shape.

Built-ins have no dependencies of their own and are imported here, so a server
that does not use one never pays for it. A provider that needs an optional
package (``oidc`` needs PyJWT) imports it inside ``create()``, only when selected.

CONTRACT.md: "Providers".
What a customer changes: nothing; add a file and point ``DC_<KIND>`` at it.
"""

from __future__ import annotations

import importlib.util
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

from ..config import is_provider_path
from ..problems import BootProblem, problem
from .data import dynamodb as dynamodb_data
from .data import memory as memory_data
from .data import postgres as postgres_data
from .data import sqlite as sqlite_data
from .data.common import DATA_METHODS
from .fanout import local as local_fanout
from .fanout import poll as poll_fanout
from .fanout import postgres as postgres_fanout
from .fanout import redis as redis_fanout
from .identity import dev, oidc, passcode
from .log import console as console_log
from .ratelimit import memory, off
from .ratelimit import redis as redis_limiter
from .secrets import aws_secrets_manager as aws_secrets_manager
from .secrets import aws_ssm as aws_ssm
from .secrets import doppler as doppler_secrets
from .secrets import env as env_secrets
from .secrets import file as file_secrets
from .secrets import infisical as infisical_secrets
from .secrets import onepassword as onepassword_secrets
from .secrets import vault as vault_secrets
from .store import dynamodb as dynamodb_store
from .store import memory as memory_store
from .store import postgres as postgres_store
from .store import redis as redis_store
from .store import sqlite as sqlite_store
from .store.common import STORE_METHODS
from .webhooks import bullmq as bullmq_webhooks
from .webhooks import inline as inline_webhooks
from .webhooks import netlify_async as netlify_async_webhooks
from .webhooks import qstash as qstash_webhooks
from .webhooks import sqs as sqs_webhooks
from .webhooks import store as store_webhooks
from .webhooks import vercel_queue as vercel_queue_webhooks

# The environment variable that selects each kind of provider.
KIND_VARIABLES = {
    "identity": "DC_IDENTITY",
    "secrets": "DC_SECRETS",
    "ratelimit": "DC_RATE_LIMIT",
    "log": "DC_LOG",
    "observer": "DC_OBSERVER",
    "store": "DC_STORE",
    "fanout": "DC_FANOUT",
    "webhooks": "DC_WEBHOOKS",
    "data": "DC_DATA",
}

# What each kind uses when its variable is unset; observers default to none. The store, fan-out and webhook
# defaults shown here are the plain-local ones: config.py picks the real default from the other settings.
KIND_DEFAULTS: dict[str, str | None] = {
    "identity": "dev",
    "secrets": "env",
    "ratelimit": "memory",
    "log": "console",
    "observer": None,
    "store": "memory",
    "fanout": "local",
    "webhooks": "store",
    "data": "memory",
}

# The built-in providers by kind and name.
BUILTINS: dict[str, dict[str, ModuleType]] = {
    "identity": {"dev": dev, "passcode": passcode, "oidc": oidc},
    "secrets": {
        "env": env_secrets,
        "file": file_secrets,
        "doppler": doppler_secrets,
        "infisical": infisical_secrets,
        "1password": onepassword_secrets,
        "vault": vault_secrets,
        "aws-secrets-manager": aws_secrets_manager,
        "aws-ssm": aws_ssm,
    },
    "ratelimit": {"memory": memory, "off": off, "redis": redis_limiter},
    "log": {"console": console_log},
    "observer": {},
    "store": {
        "memory": memory_store,
        "sqlite": sqlite_store,
        "postgres": postgres_store,
        "redis": redis_store,
        "dynamodb": dynamodb_store,
    },
    "fanout": {"local": local_fanout, "redis": redis_fanout, "postgres": postgres_fanout, "poll": poll_fanout},
    "webhooks": {
        "store": store_webhooks,
        "bullmq": bullmq_webhooks,
        "inline": inline_webhooks,
        "sqs": sqs_webhooks,
        "vercel-queue": vercel_queue_webhooks,
        "netlify-async": netlify_async_webhooks,
        "qstash": qstash_webhooks,
    },
    "data": {"memory": memory_data, "sqlite": sqlite_data, "postgres": postgres_data, "dynamodb": dynamodb_data},
}

# The methods an instance of each kind must have (observers only need hooks, so none are required).
REQUIRED_METHODS = {
    "identity": ("authenticate",),
    "secrets": ("load",),
    "ratelimit": ("hit",),
    "log": ("write",),
    "observer": (),
    "store": STORE_METHODS,
    "fanout": ("publish", "subscribe", "ready", "close"),
    "webhooks": ("dispatch", "start", "stop", "ready"),
    "data": DATA_METHODS,
}

# The hook names an observer may implement, in the order a request meets them.
HOOK_NAMES = ("on_request", "on_response", "on_error", "on_webhook", "on_token_minted")


@dataclass(frozen=True)
class ProviderContext:
    """What ``create(ctx)`` receives: the same things in Node (``{ config, env, log, root, ... }``).

    Attributes:
        config: The loaded config (may be None while a secrets provider is created, before config exists).
        env: The environment after any secrets provider has merged its values in.
        log: A redacting logger.
        root: The starter root, for resolving relative paths.
        store: The event store, for fan-outs and webhook modes (None for other kinds).
        processor: The event processor, for webhook modes (None for other kinds).
    """

    config: Any
    env: Mapping[str, str]
    log: Any
    root: Path
    store: Any = None
    processor: Any = None


def shape_problem(module: object) -> str | None:
    """Checks a provider module has the documented shape.

    Args:
        module: The imported module.

    Returns:
        What is wrong, or None when it is fine.
    """
    if module is None:
        return "it exports nothing"
    if not isinstance(getattr(module, "name", None), str) or not module.name:
        return "it must define a `name` string"
    if not isinstance(getattr(module, "config_keys", None), (list, tuple)):
        return "it must define a `config_keys` list"
    if not callable(getattr(module, "validate", None)):
        return "it must define a `validate(env)` function"
    if not callable(getattr(module, "create", None)):
        return "it must define a `create(ctx)` function"
    return None


def resolve_provider(kind: str, spec: str | None, root: Path) -> tuple[ModuleType | None, BootProblem | None]:
    """Finds the module behind one ``DC_<KIND>`` value.

    Args:
        kind: ``identity``, ``secrets``, ``ratelimit``, ``log``, ``observer``, ``store``, ``fanout``, ``webhooks``
            or ``data``.
        spec: The configured value: a built-in name, a relative path, or None for none.
        root: The starter root that relative paths are resolved against.

    Returns:
        ``(module, None)`` on success, ``(None, None)`` when ``spec`` is None, or
        ``(None, problem)`` explaining why it could not be loaded.
    """
    if spec is None:
        return None, None
    variable = KIND_VARIABLES[kind]
    if not is_provider_path(spec):
        builtin = BUILTINS[kind].get(spec)
        if builtin is not None:
            return builtin, None
        return None, problem(
            "unknown_provider",
            variable + "=" + spec + " is not a built-in " + kind + " provider.",
            "Use one of " + ", ".join(BUILTINS[kind]) + ", or a relative path to your own file.",
        )
    loaded, error = load_provider_file(kind, root / spec)
    if error is not None:
        return None, problem(
            "invalid_provider",
            variable + " points at " + spec + ", which could not be loaded: " + error + ".",
            "Check the path is relative to the starter root and the file defines name, "
            "config_keys, validate and create.",
        )
    wrong = shape_problem(loaded)
    if wrong:
        return None, problem(
            "invalid_provider",
            variable + " points at " + spec + ", but " + wrong + ".",
            "See docs/providers/" + kind + ".md for the shape.",
        )
    return loaded, None


def load_provider_file(kind: str, file: Path) -> tuple[ModuleType | None, str | None]:
    """Imports a provider from a file path.

    A provider is the customer's own file, named in the environment, so its
    path is only known at run time.

    Args:
        kind: The provider kind, used to give the module a unique name.
        file: Path to the ``.py`` file.

    Returns:
        ``(module, None)`` or ``(None, reason)``.
    """
    try:
        spec = importlib.util.spec_from_file_location("starter_crm_provider_" + kind + "_" + file.stem, file)
        if spec is None or spec.loader is None:
            return None, "it is not a Python file"
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
    except (OSError, SyntaxError, ImportError) as err:
        return None, str(err) or err.__class__.__name__
    except Exception as err:  # noqa: BLE001 - a customer's module may raise anything while it loads
        return None, err.__class__.__name__ + ": " + str(err)
    return module, None
