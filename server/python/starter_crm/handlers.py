"""Your webhook handlers: code that runs once for each event the server receives.

Where it sits: the processor (``processor.py``) calls ``run_handlers()`` for an event after
it is recorded and queued, and before it is marked processed and sent to the browser's event
stream. Set ``DC_WEBHOOK_HANDLERS`` to a file that defines ``handlers``, a dict from event
name to function::

    def on_message(event, ctx):
        ...  # ctx.event_id, ctx.attempt, ctx.signal (a threading.Event), ctx.log

    handlers = {"contact.msg.received": on_message, "*": lambda event, ctx: None}

Delivery is at-least-once: a handler can run more than once for the same event (a retry after
a crash, a replay), so it must be idempotent. Use ``ctx.event_id`` as the key for whatever it
writes. A handler that raises is retried with backoff up to ``DC_WEBHOOK_MAX_ATTEMPTS``, then
the event is marked ``failed`` and ``python -m starter_crm.cli replay <event_id>`` runs it
again. In ``inline`` mode ``ctx.signal`` is set when the handler budget runs out; check
``ctx.signal.is_set()`` in long loops. The Node server has the same loader (``src/handlers.js``).

CONTRACT.md: "POST /webhooks/dropcowboy" (handlers).
What a customer changes: this is the file you point at; the loader itself stays as it is.
"""

from __future__ import annotations

import importlib.util
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class HandlerContext:
    """What each handler receives after the event.

    Attributes:
        event_id: The event's id; use it as an idempotency key.
        attempt: Which run this is, counting from 1.
        signal: Set when the inline handler budget has run out.
        log: The redacting logger.
    """

    event_id: str
    attempt: int
    signal: threading.Event
    log: Any


def load_handlers(config: Any) -> tuple[dict[str, Callable], str | None]:
    """Loads the handlers file named by ``DC_WEBHOOK_HANDLERS``.

    Args:
        config: The loaded config.

    Returns:
        ``(handlers, None)``, with an empty dict when none is configured, or ``({}, problem)`` describing
        what is wrong with the file.
    """
    if not config.events.handlers_path:
        return {}, None
    file = (Path(config.root) / config.events.handlers_path).resolve()
    try:
        # The handlers file is the customer's own, named in the environment, so its path is only known at run time.
        spec = importlib.util.spec_from_file_location("starter_crm_handlers", file)
        if spec is None or spec.loader is None:
            return {}, "could not be loaded: it is not a Python file"
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
    except Exception as err:  # noqa: BLE001 - a customer's module may raise anything while it loads
        return {}, "could not be loaded: " + (str(err) or err.__class__.__name__)
    table = getattr(module, "handlers", None)
    if not isinstance(table, dict):
        return {}, "must define `handlers`, a dict mapping event names to functions"
    for key, fn in table.items():
        if not callable(fn):
            return {}, 'handler "' + str(key) + '" is not a function'
    return table, None


def run_handlers(handlers: dict[str, Callable], event: dict, ctx: HandlerContext) -> None:
    """Runs every handler that matches an event, one after another.

    Args:
        handlers: The map from ``load_handlers()``.
        event: The public event (``event_id``, ``event``, ``data`` and so on).
        ctx: What each handler receives after the event.

    Raises:
        Exception: The first handler's error; later handlers do not run.
    """
    names = []
    if isinstance(event.get("event"), str) and event["event"] in handlers:
        names.append(event["event"])
    if "*" in handlers:
        names.append("*")
    for name in names:
        handlers[name](event, ctx)
