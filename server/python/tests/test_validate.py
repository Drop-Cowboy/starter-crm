"""Request-body schemas judge values the same way as the Node server, from the shared vectors."""

from __future__ import annotations

import json

import pytest

from starter_crm.errors import HttpError
from starter_crm.provider_check import STARTER_ROOT
from starter_crm.validate import assert_supported, check_body, first_problem, load_schemas

VECTORS = json.loads(
    (STARTER_ROOT / "server" / "conformance" / "provider" / "schema-vectors.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("entry", VECTORS["cases"], ids=lambda entry: entry["name"])
def test_judges_like_the_shared_vectors(entry):
    assert first_problem(entry["schema"], entry["value"]) == entry["problem"]


def test_check_body_answers_400_invalid_request_with_a_full_stop():
    schema = {"type": "object", "required": ["title"], "properties": {"title": {"type": "string"}}}
    with pytest.raises(HttpError) as raised:
        check_body(schema, {})
    assert raised.value.status == 400
    assert raised.value.code == "invalid_request"
    assert raised.value.message == "title: is required."


def test_check_body_accepts_a_body_that_fits():
    check_body({"type": "object"}, {})


def test_loads_the_deals_schemas():
    assert sorted(load_schemas("deals")) == ["create", "query", "update"]


def test_refuses_a_keyword_the_checker_does_not_implement():
    with pytest.raises(ValueError, match="oneOf"):
        assert_supported({"type": "object", "oneOf": []}, "x")
    with pytest.raises(ValueError):
        assert_supported({"type": "object", "properties": {"a": {"type": "string", "format": "email"}}}, "x")
