from __future__ import annotations

import time

from helpers import WEBHOOK_SECRET, make_client, make_config, sign

from starter_crm.events import EventStore
from starter_crm.webhooks import verify_signature

NOW = 1790000000
BODY = '{"event_id":"d1f3a8e2-7c4b-4f9a-9d22-9c1e2f3a4b5c","event":"contact.rvm.status","data":{}}'


def check(**overrides):
    timestamp = str(NOW)
    arguments = {
        "raw_body": BODY.encode("utf-8"),
        "signature": sign(BODY, WEBHOOK_SECRET, timestamp),
        "timestamp": timestamp,
        "version": "v1",
        "secrets": [WEBHOOK_SECRET],
        "now_seconds": NOW,
    }
    arguments.update(overrides)
    return verify_signature(**arguments)


def test_accepts_a_valid_signature():
    assert check().ok


def test_accepts_a_signature_from_any_configured_secret_one_per_subscription():
    assert check(secrets=["secret-for-another-event", WEBHOOK_SECRET]).ok
    assert check(secrets=["secret-for-another-event"]).code == "invalid_signature"
    assert check(secrets=[]).code == "invalid_signature"


def test_rejects_a_signature_made_with_another_secret():
    assert check(signature=sign(BODY, "another-secret", str(NOW))).code == "invalid_signature"


def test_rejects_a_changed_body():
    assert check(raw_body=BODY.replace("rvm", "sms").encode("utf-8")).code == "invalid_signature"


def test_rejects_timestamps_more_than_5_minutes_old_or_ahead():
    assert check(now_seconds=NOW + 300).ok
    assert check(now_seconds=NOW + 301).code == "stale_timestamp"
    assert check(now_seconds=NOW - 301).code == "stale_timestamp"


def test_rejects_malformed_timestamps_missing_headers_and_unknown_versions():
    assert check(timestamp="1790000000.5").code == "stale_timestamp"
    assert check(timestamp="١٧٩٠٠٠٠٠٠٠").code == "stale_timestamp"
    assert check(signature=None).code == "missing_signature"
    assert check(timestamp="").code == "missing_signature"
    assert check(version="v2").code == "invalid_signature"
    assert check(version=None).ok


def test_rejects_a_signature_of_the_wrong_length_without_throwing():
    assert check(signature="sha256=abc").code == "invalid_signature"
    assert check(signature="sha256=é").code == "invalid_signature"


def deliver(client, body, event_id="", secret=WEBHOOK_SECRET, timestamp=None):
    timestamp = timestamp or str(int(time.time()))
    return client.post(
        "/webhooks/dropcowboy",
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Signature": sign(body, secret, timestamp),
            "X-Timestamp": timestamp,
            "X-Signature-Version": "v1",
            "X-Event-Id": event_id,
            "X-Attempt": "1",
        },
    )


def test_verifies_the_raw_bytes_not_re_serialised_json():
    spaced = '{ "event_id" : "a9c3e8f1-4b2d-4a7c-8e9b-1c2d3e4f5a6b",\n  "event": "contact.msg.received", "data": {} }'
    response = deliver(make_client(make_config()), spaced)
    assert response.status_code == 200
    assert response.get_json() == {"received": True}


def test_acknowledges_a_replayed_event_id_without_storing_it_twice():
    store = EventStore()
    client = make_client(make_config(), store=store)
    event_id = "b3e7a1c9-8d5f-4b2e-9a6c-1f4d7b3e8a52"
    first = deliver(client, BODY, event_id=event_id)
    second = deliver(client, BODY, event_id=event_id)

    assert first.get_json() == {"received": True}
    assert second.status_code == 200
    assert second.get_json() == {"received": True, "duplicate": True}
    assert len(store.since(None)) == 1


def test_stores_the_event_in_the_contract_shape():
    store = EventStore()
    deliver(make_client(make_config(), store=store), BODY)
    [event] = store.since(None)
    assert event["event_id"] == "d1f3a8e2-7c4b-4f9a-9d22-9c1e2f3a4b5c"
    assert (event["event"], event["event_at"], event["attempt"], event["data"]) == ("contact.rvm.status", None, 1, {})
    assert isinstance(event["received_at"], int)


def test_verifies_against_every_secret_in_a_comma_separated_webhook_secret():
    client = make_client(make_config(DROPCOWBOY_WEBHOOK_SECRET="first-subscription-secret , " + WEBHOOK_SECRET))
    first = deliver(client, BODY, secret="first-subscription-secret", event_id="0f1e2d3c-4b5a-4968-8776-655443322110")
    second = deliver(client, BODY, secret=WEBHOOK_SECRET, event_id="1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d")
    padded = deliver(client, BODY, secret="first-subscription-secret ", event_id="2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e")
    assert (first.status_code, second.status_code, padded.status_code) == (200, 200, 401)


def test_answers_401_invalid_signature_for_the_wrong_secret():
    response = deliver(make_client(make_config()), BODY, secret="wrong-secret")
    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "invalid_signature"


def test_answers_401_stale_timestamp_for_an_old_delivery():
    response = deliver(make_client(make_config()), BODY, timestamp=str(int(time.time()) - 600))
    assert response.status_code == 401
    assert response.get_json()["error"]["code"] == "stale_timestamp"


def test_answers_400_invalid_json_for_a_signed_body_that_is_not_a_json_object():
    for body in ["event=contact.msg.received", "[]", '{"a": NaN}']:
        response = deliver(make_client(make_config()), body)
        assert response.status_code == 400
        assert response.get_json()["error"]["code"] == "invalid_json"


def test_answers_503_when_no_webhook_secret_is_configured():
    response = deliver(make_client(make_config(DROPCOWBOY_WEBHOOK_SECRET="")), BODY)
    assert response.status_code == 503
    assert response.get_json()["error"]["code"] == "webhook_not_configured"
