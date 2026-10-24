"""Your modules: server code for the things your CRM tracks that Drop Cowboy does not.

Where it sits: every file in ``starter_crm/modules/`` that defines ``MODULE`` is a module. Boot (``bootstrap.py``)
loads them all with ``load_modules()``, ``create_app()`` registers each one's routes under ``/api/modules/<id>/``
(from ``create_modules()``), and the processor hands every finished webhook event to ``run_event_hooks()``. The
built-in example is ``modules/deals.py``; ``npm run new:module -- tickets`` copies it. Nothing in core names a
module. The Node server has the same framework (``src/modules.js``).

A module is a ``Module``::

    def routes(router):
        router.get("/", lambda ctx: {"deals": ctx.data.collection("deals").list()})
        router.post("/", create, body=schemas["create"])
        router.delete("/:id", remove)

    def archive(event, ctx):
        ...

    MODULE = Module(id="deals", routes=routes, on_event={"contact.deleted": archive})

A route handler receives ``ctx``: ``user`` (who is signed in), ``data`` (the data API, already limited to that user,
so there is no way to read another user's documents), ``log``, ``dropcowboy(method, path, body=None)`` (a call to the
Drop Cowboy API with this server's key), ``signal`` (a ``threading.Event``), ``params`` (the ``:name`` parts of the
path), ``query`` (the query string; the first of a repeated name), ``body`` (the validated JSON body, when the route
names a ``body`` schema) and ``reply(status, body)``. Returning a value answers 200 with it as JSON;
``ctx.reply(201, value)`` picks another status; raise an ``HttpError`` for an error envelope. An event handler gets
the event and a ``ModuleEventContext`` with ``data`` over EVERY owner (``data.system()``), ``log``, ``dropcowboy``,
``signal``, ``event_id`` and ``attempt``. Delivery is at-least-once, so an event handler must be idempotent.

Routes need a signed-in user, so modules are mounted in ``DC_AUTH_MODE=server`` only.

CONTRACT.md: "Modules".
What a customer changes: nothing here; add a file under ``starter_crm/modules/``.
"""

from __future__ import annotations

import importlib
import pkgutil
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from flask import Response, g, jsonify, request

from . import modules as modules_package
from .body import read_json_body
from .config import Config
from .errors import HttpError
from .upstream import call_dropcowboy
from .validate import assert_supported, check_body

# What a module id may look like. It becomes part of every URL the module serves.
MODULE_ID = re.compile(r"[a-z][a-z0-9-]{0,31}")

# What a route path may look like: ``/``, or segments that are lowercase words or ``:name`` parameters.
_SEGMENT = r"(?:[a-z0-9_-]+|:[a-z][a-z0-9_]*)"
ROUTE_PATH = re.compile(r"/(?:" + _SEGMENT + r"(?:/" + _SEGMENT + r")*)?")

# Requests one user may make to module routes per minute.
USER_PER_MINUTE = 600


@dataclass
class Module:
    """A module: an id, optional routes and optional event handlers.

    Attributes:
        id: Lowercase letters, digits and dashes; the file name with underscores turned into dashes.
        routes: Called once at boot with the router, to declare routes.
        on_event: Maps an event name (or ``"*"``) to ``function(event, ctx)``.
    """

    id: str
    routes: Callable[[Router], None] | None = None
    on_event: dict[str, Callable] = field(default_factory=dict)


class Reply:
    """The answer a route chose with ``ctx.reply()``."""

    def __init__(self, status: int, body: Any):
        """Creates the answer.

        Args:
            status: The HTTP status.
            body: Anything ``jsonify`` accepts.
        """
        self.status = status
        self.body = body


@dataclass
class ModuleContext:
    """What a route handler receives.

    Attributes:
        user: The signed-in user (``id``, ``email``, ``name``).
        data: The data API, limited to that user.
        log: The request's logger.
        dropcowboy: ``dropcowboy(method, path, body=None)`` calls the Drop Cowboy API with this server's key.
        signal: A ``threading.Event`` that is never set for a plain request.
        params: The ``:name`` parts of the path.
        query: The query string; the first of a repeated name.
        body: The validated JSON body, or None when the route has no ``body`` schema.
        request: The Flask request, for anything not covered above.
    """

    user: Any
    data: Any
    log: Any
    dropcowboy: Callable[..., Any]
    signal: threading.Event
    params: dict[str, str]
    query: dict[str, str]
    body: Any
    request: Any

    @staticmethod
    def reply(status: int, body: Any) -> Reply:
        """Answers with a status other than 200.

        Args:
            status: The HTTP status.
            body: The JSON body.

        Returns:
            What the handler should return.
        """
        return Reply(status, body)


@dataclass
class ModuleEventContext:
    """What an event handler receives after the event.

    Attributes:
        data: The data API over every owner of the site.
        log: The logger.
        dropcowboy: ``dropcowboy(method, path, body=None)`` calls the Drop Cowboy API with this server's key.
        signal: Set when the inline handler budget has run out.
        event_id: The event's id; use it as an idempotency key.
        attempt: Which run this is, counting from 1.
    """

    data: Any
    log: Any
    dropcowboy: Callable[..., Any]
    signal: threading.Event
    event_id: str
    attempt: int


@dataclass
class Route:
    """One route a module declared, with its full path.

    Attributes:
        method: ``GET``, ``POST`` or ``DELETE``.
        path: The full path with ``:name`` parts, such as ``/api/modules/deals/:id``.
        body: The schema the JSON body must fit, or None.
        handler: The function that answers.
    """

    method: str
    path: str
    body: dict | None
    handler: Callable[[ModuleContext], Any]

    @property
    def flask_path(self) -> str:
        """The path in Flask's syntax: ``:id`` becomes ``<id>``.

        Returns:
            The path.
        """
        return re.sub(r":([a-z][a-z0-9_]*)", r"<\1>", self.path)


class Router:
    """What ``routes(router)`` receives: declare routes with ``get``, ``post`` and ``delete``."""

    def __init__(self, module_id: str):
        """Creates an empty router for one module.

        Args:
            module_id: The module's id; every path is under ``/api/modules/<id>``.
        """
        self._id = module_id
        self.found: list[Route] = []

    def _add(self, method: str, path: str, handler: Callable, body: dict | None) -> None:
        """Records one route after checking it.

        Args:
            method: The HTTP method.
            path: The path under the module, such as ``/`` or ``/:id``.
            handler: The function that answers.
            body: The body schema, or None.

        Raises:
            ValueError: When the path or handler is wrong, the schema uses an unsupported keyword, or the route repeats.
        """
        label = "router." + method.lower() + "(" + str(path) + ")"
        if not callable(handler):
            raise ValueError(label + " needs a handler function")
        if not isinstance(path, str) or ROUTE_PATH.fullmatch(path) is None:
            raise ValueError(label + ' path must be "/" or segments like "/items/:id"')
        if body is not None:
            if method == "GET":
                raise ValueError("a GET route cannot have a body schema")
            assert_supported(body, self._id + " " + method + " " + path)
        full = "/api/modules/" + self._id + ("" if path == "/" else path)
        if any(route.method == method and route.path == full for route in self.found):
            raise ValueError("route " + method + " " + full + " is declared twice")
        self.found.append(Route(method, full, body, handler))

    def get(self, path: str, handler: Callable) -> None:
        """Declares a GET route.

        Args:
            path: The path under the module.
            handler: ``function(ctx)``.
        """
        self._add("GET", path, handler, None)

    def post(self, path: str, handler: Callable, body: dict | None = None) -> None:
        """Declares a POST route (creates and updates).

        Args:
            path: The path under the module.
            handler: ``function(ctx)``.
            body: A schema the JSON body must fit, checked before the handler runs.
        """
        self._add("POST", path, handler, body)

    def delete(self, path: str, handler: Callable) -> None:
        """Declares a DELETE route.

        Args:
            path: The path under the module.
            handler: ``function(ctx)``.
        """
        self._add("DELETE", path, handler, None)


def load_modules() -> tuple[list[Module], str | None]:
    """Finds and loads every module in ``starter_crm/modules/``.

    Returns:
        ``(modules, None)`` in file-name order, or ``([], problem)`` describing what is wrong with one.
    """
    found: list[Module] = []
    for info in sorted(pkgutil.iter_modules(modules_package.__path__), key=lambda item: item.name):
        if info.name.startswith("_"):
            continue
        try:
            loaded = importlib.import_module(modules_package.__name__ + "." + info.name)
        except Exception as err:  # noqa: BLE001 - a customer's module may raise anything while it loads
            return [], 'module "' + info.name + '" could not be loaded: ' + (str(err) or err.__class__.__name__)
        wrong = shape_problem(getattr(loaded, "MODULE", None), info.name)
        if wrong:
            return [], 'module "' + info.name + '" ' + wrong
        found.append(loaded.MODULE)
    return found, None


def shape_problem(module: Any, file_stem: str) -> str | None:
    """Checks a module has the documented shape.

    Args:
        module: What the file defines as ``MODULE``.
        file_stem: The file name without ``.py``; the id must match it (underscores read as dashes).

    Returns:
        What is wrong, or None when it is fine.
    """
    if not isinstance(module, Module):
        return "must define MODULE = Module(id=...)"
    if not isinstance(module.id, str) or MODULE_ID.fullmatch(module.id) is None:
        return "needs an `id` of lowercase letters, digits and dashes (got " + repr(module.id) + ")"
    if module.id != file_stem.replace("_", "-"):
        return 'has id "' + module.id + '", which must match its file name'
    if module.routes is not None and not callable(module.routes):
        return "`routes` must be a function taking the router"
    if not isinstance(module.on_event, dict):
        return "`on_event` must be a dict mapping event names to functions"
    for key, handler in module.on_event.items():
        if not callable(handler):
            return 'event handler "' + str(key) + '" is not a function'
    return None


class ModuleRuntime:
    """What ``create_app()`` and the processor use: the routes, and the event runner."""

    def __init__(self, modules: list[Module], data: Any, config: Config, log: Any):
        """Collects every module's routes.

        Args:
            modules: The loaded modules.
            data: The data provider instance.
            config: The loaded config.
            log: The logger.

        Raises:
            ValueError: When a module declares a bad route.
        """
        self._data = data
        self._config = config
        self._listeners = [module for module in modules if module.on_event]
        self.routes: list[Route] = []
        for module in modules:
            router = Router(module.id)
            if module.routes is not None:
                module.routes(router)
            self.routes.extend(router.found)

    def dropcowboy(self, method: str, path: str, body: Any = None) -> Any:
        """Calls the Drop Cowboy API with this server's key.

        Args:
            method: The HTTP method.
            path: The API path.
            body: The JSON body, or None.

        Returns:
            The parsed JSON answer.
        """
        return call_dropcowboy(self._config, method, path, body)

    def run_event_hooks(self, event: dict, ctx: Any) -> None:
        """Hands one event to every module that listens for it.

        Args:
            event: The public event (``event_id``, ``event``, ``data`` and so on).
            ctx: The processor's handler context (``event_id``, ``attempt``, ``signal``, ``log``).

        Raises:
            Exception: The first handler's error; later handlers do not run.
        """
        for module in self._listeners:
            names = []
            if isinstance(event.get("event"), str) and event["event"] in module.on_event:
                names.append(event["event"])
            if "*" in module.on_event:
                names.append("*")
            for name in names:
                module.on_event[name](
                    event,
                    ModuleEventContext(
                        data=self._data.system(),
                        log=ctx.log,
                        dropcowboy=self.dropcowboy,
                        signal=ctx.signal,
                        event_id=ctx.event_id,
                        attempt=ctx.attempt,
                    ),
                )

    def view_for(self, route: Route) -> Callable:
        """Builds the Flask view that runs one route, after ``require_user`` has set ``g.user``.

        Args:
            route: The route.

        Returns:
            A view function taking the path parameters as keyword arguments.
        """

        def run_module_route(**params: str):
            g.limit("module-user", g.user.id, USER_PER_MINUTE)
            body = None
            if route.body is not None:
                body = read_json_body()
                if body is None:
                    raise HttpError(415, "unsupported_media_type", "Send this request as application/json.")
                check_body(route.body, body)
            result = route.handler(
                ModuleContext(
                    user=g.user,
                    data=self._data.scope(g.user.id),
                    log=g.log,
                    dropcowboy=self.dropcowboy,
                    signal=threading.Event(),
                    params=dict(params),
                    query=request.args.to_dict(),
                    body=body,
                    request=request,
                )
            )
            if isinstance(result, Response):
                return result
            if isinstance(result, Reply):
                return jsonify(result.body), result.status
            return jsonify({} if result is None else result)

        return run_module_route
