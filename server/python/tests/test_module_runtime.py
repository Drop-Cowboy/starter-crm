"""The module framework: shape checks, route declaration, loading and event hooks (the Node twin is modules.test.js)."""

from __future__ import annotations

import threading
from types import SimpleNamespace

import pytest
from helpers import make_config, silent_logger

from starter_crm.module_runtime import Module, ModuleRuntime, Router, load_modules, shape_problem
from starter_crm.providers.data import memory as memory_data


def noop(ctx):
    return {}


class TestShapeProblem:
    def test_accepts_a_module_whose_id_matches_its_file(self):
        assert shape_problem(Module(id="tickets", routes=lambda router: None, on_event={"*": noop}), "tickets") is None
        assert shape_problem(Module(id="my-tickets"), "my_tickets") is None

    @pytest.mark.parametrize(
        ("module", "stem", "message"),
        [
            (None, "tickets", "must define MODULE"),
            (Module(id="Tickets"), "Tickets", "id"),
            (Module(id="tickets"), "other", "match its file name"),
            (Module(id="tickets", routes="x"), "tickets", "routes"),
            (Module(id="tickets", on_event={"contact.deleted": 1}), "tickets", "not a function"),
        ],
    )
    def test_names_what_is_wrong(self, module, stem, message):
        assert message in shape_problem(module, stem)


class TestRouter:
    def collect(self, routes):
        router = Router("tickets")
        routes(router)
        return router.found

    def test_gives_each_route_its_full_path(self):
        def routes(router):
            router.get("/", noop)
            router.post("/:id", noop, body={"type": "object"})
            router.delete("/:id", noop)

        found = self.collect(routes)
        assert [f"{r.method} {r.path}" for r in found] == [
            "GET /api/modules/tickets",
            "POST /api/modules/tickets/:id",
            "DELETE /api/modules/tickets/:id",
        ]
        assert found[1].flask_path == "/api/modules/tickets/<id>"
        assert found[1].body == {"type": "object"}

    def test_refuses_a_bad_path_a_repeated_route_a_missing_handler_a_get_body_and_an_unsupported_keyword(self):
        with pytest.raises(ValueError, match="path"):
            self.collect(lambda router: router.get("items", noop))
        with pytest.raises(ValueError, match="path"):
            self.collect(lambda router: router.get("/../x", noop))
        with pytest.raises(ValueError, match="twice"):
            self.collect(lambda router: (router.get("/", noop), router.get("/", noop)))
        with pytest.raises(ValueError, match="handler"):
            self.collect(lambda router: router.get("/", "nope"))
        with pytest.raises(ValueError, match="oneOf"):
            self.collect(lambda router: router.post("/", noop, body={"oneOf": []}))


def test_loads_the_built_in_deals_module():
    modules, problem = load_modules()
    assert problem is None
    assert "deals" in [module.id for module in modules]


class TestEventHooks:
    def runtime(self, modules):
        config = make_config()
        return ModuleRuntime(modules, memory_data.MemoryData(), config, silent_logger())

    def context(self):
        return SimpleNamespace(event_id="e1", attempt=2, signal=threading.Event(), log=silent_logger())

    def test_hands_an_event_to_the_modules_that_name_it_and_to_star(self):
        seen = []
        modules = [
            Module(
                id="one",
                on_event={"contact.deleted": lambda event, ctx: seen.append(("one", ctx.event_id, ctx.attempt))},
            ),
            Module(id="two", on_event={"*": lambda event, ctx: seen.append(("two", event["event"]))}),
            Module(id="three", on_event={"contact.created": lambda event, ctx: seen.append(("three",))}),
        ]
        self.runtime(modules).run_event_hooks({"event": "contact.deleted"}, self.context())
        assert seen == [("one", "e1", 2), ("two", "contact.deleted")]

    def test_lets_a_failing_handler_fail_the_whole_run_so_the_event_is_retried(self):
        def boom(event, ctx):
            raise RuntimeError("boom")

        with pytest.raises(RuntimeError, match="boom"):
            self.runtime([Module(id="one", on_event={"*": boom})]).run_event_hooks({"event": "x"}, self.context())
