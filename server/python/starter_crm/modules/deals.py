"""The Deals module: the worked example of a Starter CRM module, end to end.

Where it sits: a deal is a thing you are selling, optionally tied to a Drop Cowboy contact. The browser's Deals page
calls these routes; the data lives in the ``deals`` collection of the data API (``DC_DATA``), so every deal belongs to
the user who made it and nobody else can read or change it. When Drop Cowboy tells this server a contact was deleted,
the ``contact.deleted`` handler archives that contact's deals, so the page no longer shows a deal for a person who asked
to be forgotten.

Routes (all need a signed-in user; creates and updates are POST, deletes are DELETE):

- ``GET    /api/modules/deals``      list this user's deals, newest first. Filters: ``stage``, ``contact_id``,
  ``archived=true|false|all`` (default false).
- ``POST   /api/modules/deals``      create one: ``{title, contact_id?, amount_cents?, currency?, stage?, notes?}``.
- ``GET    /api/modules/deals/:id``  read one.
- ``POST   /api/modules/deals/:id``  change some fields of one.
- ``DELETE /api/modules/deals/:id``  delete one for good.

The request shapes are in ``server/schemas/deals.json``, shared with the Node server (``src/modules/deals/index.js``),
so both reject the same input with ``400 invalid_request`` and the name of the field.

CONTRACT.md: "Modules" (Deals).
To make your own: ``npm run new:module -- tickets`` copies this file and renames it; see CUSTOMIZE.md.
"""

from __future__ import annotations

import re
from typing import Any

from ..errors import HttpError
from ..module_runtime import Module, ModuleContext, ModuleEventContext, Router
from ..validate import check_body, load_schemas

# The data API collection this module keeps its documents in.
COLLECTION = "deals"

# A safety stop on the archive loop below: 1000 passes of 100 deals, never reached in practice.
MAX_ARCHIVE_PASSES = 1000

schemas = load_schemas("deals")
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)


def _missing() -> HttpError:
    """The error for a deal that is not there, or is not this user's: the two look the same on purpose.

    Returns:
        404 ``deal_not_found``.
    """
    return HttpError(404, "deal_not_found", "No deal with that id.")


def _deal_id(params: dict[str, str]) -> str:
    """Reads a deal id from the path. Anything that is not a UUID cannot be a deal, so it never reaches the database.

    Args:
        params: The route parameters.

    Returns:
        The id.

    Raises:
        HttpError: 404 ``deal_not_found`` for something that is not a UUID.
    """
    if _UUID.fullmatch(params["id"]) is None:
        raise _missing()
    return params["id"]


def _list_deals(ctx: ModuleContext) -> dict:
    """Lists this user's deals, newest first.

    Args:
        ctx: The route context.

    Returns:
        ``{"deals": [...]}``.
    """
    check_body(schemas["query"], ctx.query)
    where: dict[str, Any] = {}
    if ctx.query.get("stage"):
        where["stage"] = ctx.query["stage"]
    if ctx.query.get("contact_id"):
        where["contact_id"] = ctx.query["contact_id"].lower()
    if ctx.query.get("archived") != "all":
        where["archived"] = ctx.query.get("archived") == "true"
    return {"deals": ctx.data.collection(COLLECTION).list(where=where)}


def _create_deal(ctx: ModuleContext):
    """Creates a deal for this user.

    Args:
        ctx: The route context; ``body`` is already checked against the ``create`` schema.

    Returns:
        A 201 reply with ``{"deal": {...}}``.
    """
    body = ctx.body
    contact_id = body.get("contact_id")
    deal = ctx.data.collection(COLLECTION).insert(
        {
            "title": body["title"],
            "contact_id": contact_id.lower() if contact_id else None,
            "amount_cents": body.get("amount_cents", 0),
            "currency": body.get("currency", "USD"),
            "stage": body.get("stage", "lead"),
            "notes": body.get("notes", ""),
            "archived": False,
            "archived_reason": None,
        }
    )
    return ctx.reply(201, {"deal": deal})


def _read_deal(ctx: ModuleContext) -> dict:
    """Reads one of this user's deals.

    Args:
        ctx: The route context.

    Returns:
        ``{"deal": {...}}``.

    Raises:
        HttpError: 404 ``deal_not_found``.
    """
    deal = ctx.data.collection(COLLECTION).get(_deal_id(ctx.params))
    if deal is None:
        raise _missing()
    return {"deal": deal}


def _update_deal(ctx: ModuleContext) -> dict:
    """Changes some fields of one of this user's deals.

    Args:
        ctx: The route context; ``body`` is already checked against the ``update`` schema.

    Returns:
        ``{"deal": {...}}``.

    Raises:
        HttpError: 404 ``deal_not_found``.
    """
    changes = {}
    for key, value in ctx.body.items():
        changes[key] = value.lower() if key == "contact_id" and value else value
    # A person who archives or restores a deal also settles why it is archived.
    if "archived" in changes:
        changes["archived_reason"] = "manual" if changes["archived"] else None
    deal = ctx.data.collection(COLLECTION).update(_deal_id(ctx.params), changes)
    if deal is None:
        raise _missing()
    return {"deal": deal}


def _delete_deal(ctx: ModuleContext) -> dict:
    """Deletes one of this user's deals.

    Args:
        ctx: The route context.

    Returns:
        ``{"deleted": True, "id": ...}``.

    Raises:
        HttpError: 404 ``deal_not_found``.
    """
    deal_id = _deal_id(ctx.params)
    if not ctx.data.collection(COLLECTION).remove(deal_id):
        raise _missing()
    return {"deleted": True, "id": deal_id}


def routes(router: Router) -> None:
    """Declares the Deals routes.

    Args:
        router: The module's router.
    """
    router.get("/", _list_deals)
    router.post("/", _create_deal, body=schemas["create"])
    router.get("/:id", _read_deal)
    router.post("/:id", _update_deal, body=schemas["update"])
    router.delete("/:id", _delete_deal)


def archive_deleted_contact(event: dict, ctx: ModuleEventContext) -> None:
    """Archives every deal tied to a contact Drop Cowboy says was deleted. Safe to run twice.

    Args:
        event: The ``contact.deleted`` event.
        ctx: The event context; ``data`` sees every owner.
    """
    data = event.get("data")
    contact_id = data.get("contact_id") if isinstance(data, dict) else None
    if not isinstance(contact_id, str) or not contact_id:
        return
    contact_id = contact_id.lower()
    deals = ctx.data.collection(COLLECTION)
    archived = 0
    for _ in range(MAX_ARCHIVE_PASSES):
        page = deals.list(where={"contact_id": contact_id, "archived": False}, limit=100)
        if not page:
            break
        for deal in page:
            deals.update(deal["id"], {"archived": True, "archived_reason": "contact_deleted"})
            archived += 1
    if archived > 0:
        ctx.log.info("Archived " + str(archived) + " deal(s) for deleted contact " + contact_id + ".")


MODULE = Module(id="deals", routes=routes, on_event={"contact.deleted": archive_deleted_contact})
