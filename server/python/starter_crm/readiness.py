"""``GET /api/dropcowboy/readiness``: what the account still needs.

Proxies the readiness check with this server's API key, or in login mode the
signed-in user's token, so the /setup page works without the key ever
reaching the browser.
"""

from __future__ import annotations

from typing import Any, Callable

from flask import g, jsonify

from .config import Config
from .json_utils import is_number
from .upstream import call_dropcowboy


def readiness_view(config: Config) -> Callable:
    def get_readiness():
        result = call_dropcowboy(
            config, "GET", "/register/public/integration-readiness", access_token=g.get("access_token")
        )
        data = result.get("data") if isinstance(result, dict) else None
        response = jsonify(pick_readiness(data))
        response.headers["Cache-Control"] = "no-store"
        return response

    return get_readiness


def pick_readiness(data: Any) -> dict:
    """Keep only what the setup page shows.

    Pool ids, plan ids, phone number lists and integration ids stay on the
    server. Missing booleans become False, numbers 0 and lists [].
    """
    d = _object(data)
    byoc = _object(d.get("byoc"))
    funds = _object(d.get("funds"))
    numbers = _object(d.get("numbers"))

    providers = []
    for p in _list(byoc.get("providers")):
        if isinstance(p, dict):
            providers.append(
                {
                    "provider": p.get("provider") if isinstance(p.get("provider"), str) else None,
                    "enabled": p.get("enabled") is True,
                    "default": p.get("default") is True,
                }
            )

    allotment = {}
    for product, value in _object(d.get("allotment")).items():
        if isinstance(value, dict) and is_number(value.get("remaining")) and is_number(value.get("cap")):
            allotment[product] = {"remaining": value["remaining"], "cap": value["cap"]}

    next_actions = [action for action in _list(d.get("next_actions")) if isinstance(action, str)]

    return {
        "embed_ready": d.get("embed_ready") is True,
        "next_actions": next_actions,
        "building_blocks_enabled": d.get("building_blocks_enabled") is True,
        "byoc": {"connected": byoc.get("connected") is True, "providers": providers},
        "funds": {"available": _number(funds.get("available")), "funds_ok": funds.get("funds_ok") is True},
        "allotment": allotment,
        "numbers": {"count": _number(numbers.get("count"))},
        "embed_resolve_contact_consent": d.get("embed_resolve_contact_consent") is True,
    }


def _object(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list:
    return value if isinstance(value, list) else []


def _number(value: Any) -> int | float:
    return value if is_number(value) else 0
