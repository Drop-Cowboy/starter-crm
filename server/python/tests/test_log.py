from __future__ import annotations

import io
import logging

from helpers import API_KEY, API_SECRET, WEBHOOK_SECRET, make_config

from starter_crm.config import secret_values
from starter_crm.log import Logger, RedactingFilter, redact


def test_redact_removes_configured_secrets_wherever_they_appear():
    line = redact("x-key=" + API_KEY + " x-secret=" + API_SECRET + API_SECRET, [API_KEY, API_SECRET])
    assert line == "x-key=[redacted] x-secret=[redacted][redacted]"


def test_redact_removes_anything_shaped_like_a_jwt():
    assert redact("token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln done", []) == "token [redacted-token] done"


def test_redact_removes_bearer_credentials_that_are_not_jwts():
    line = redact("authorization: bearer opaque.Access-Token~1== sent", [])
    assert line == "authorization: Bearer [redacted] sent"


def test_logger_scrubs_secrets_from_strings_objects_and_errors():
    second = "second-subscription-secret"
    config = make_config(DROPCOWBOY_WEBHOOK_SECRET=WEBHOOK_SECRET + "," + second)
    out, err = io.StringIO(), io.StringIO()
    log = Logger(secret_values(config), stdout=out, stderr=err)

    log.info("headers", {"x-key": API_KEY, "x-secret": API_SECRET})
    log.warn("secrets are", WEBHOOK_SECRET, second)
    try:
        raise RuntimeError("failed with " + API_SECRET)
    except RuntimeError as caught:
        log.error(caught)

    everything = out.getvalue() + err.getvalue()
    for secret in [API_KEY, API_SECRET, WEBHOOK_SECRET, second]:
        assert secret not in everything
    assert len(out.getvalue().splitlines()) == 1
    assert "RuntimeError" in err.getvalue()


def test_redacting_filter_scrubs_library_log_records():
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    logger = logging.getLogger("starter-crm-test")
    logger.addHandler(handler)
    logger.addFilter(RedactingFilter([API_KEY]))
    try:
        logger.warning("GET /?key=%s", API_KEY)
        try:
            raise ValueError(API_KEY)
        except ValueError:
            logger.exception("failed")
    finally:
        logger.removeHandler(handler)
    assert API_KEY not in stream.getvalue()
    assert "[redacted]" in stream.getvalue()
