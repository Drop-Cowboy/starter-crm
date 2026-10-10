from __future__ import annotations

import json

import pytest
from helpers import make_client, make_config

from starter_crm.dev_session import is_loopback_address, is_loopback_host, read_session
from starter_crm.errors import HttpError

NOW_MS = 1790000000000
TOKEN = "dev-session-token"


def test_is_loopback_address_accepts_ipv4_ipv6_and_mapped_loopback():
    for address in ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]:
        assert is_loopback_address(address)


def test_is_loopback_address_rejects_everything_else():
    for address in ["10.0.0.5", "192.168.1.20", "::ffff:10.0.0.5", "0.0.0.0", "fe80::1", "127.0.0.1\n", "", None]:
        assert not is_loopback_address(address)


def test_is_loopback_host_accepts_loopback_names_with_or_without_a_port():
    for host in ["localhost", "localhost:8080", "127.0.0.1:8080", "[::1]:8080", "LOCALHOST:5173"]:
        assert is_loopback_host(host)


def test_is_loopback_host_rejects_other_names_including_rebinding_tricks():
    for host in ["evil.example", "evil.example:8080", "localhost.evil.example", "127.0.0.1.nip.io", "[::1", "", None]:
        assert not is_loopback_host(host)


@pytest.fixture
def session_root(tmp_path):
    (tmp_path / ".dropcowboy").mkdir()
    return tmp_path


def write_session(root, value):
    text = value if isinstance(value, str) else json.dumps(value)
    (root / ".dropcowboy" / "session.json").write_text(text)


def dev_client(root):
    return make_client(make_config(DC_AUTH_MODE="mcp-session", STARTER_CRM_ROOT=str(root), DROPCOWBOY_SITE_ID=""))


def test_ignores_forwarding_headers_and_judges_the_socket_address(session_root):
    write_session(session_root, {"token": TOKEN, "expires_at": 9999999999999})
    response = dev_client(session_root).get(
        "/__dev/session",
        base_url="http://localhost:8080",
        environ_base={"REMOTE_ADDR": "203.0.113.9"},
        headers={"X-Forwarded-For": "127.0.0.1", "X-Real-IP": "127.0.0.1", "Forwarded": "for=127.0.0.1"},
    )
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "loopback_only"
    assert TOKEN not in response.get_data(as_text=True)


def test_refuses_a_loopback_peer_that_sent_a_foreign_host(session_root):
    write_session(session_root, {"token": TOKEN, "expires_at": 9999999999999})
    response = dev_client(session_root).get("/__dev/session", base_url="http://evil.example:8080")
    assert response.status_code == 403
    assert response.get_json()["error"]["code"] == "loopback_only"


def test_serves_the_session_to_this_machine(session_root):
    write_session(session_root, {"token": TOKEN, "expires_at": 9999999999999})
    response = dev_client(session_root).get("/__dev/session", base_url="http://localhost:8080")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    assert response.get_json() == {"token": TOKEN, "expires_at": 9999999999999, "site_id": None}


def test_read_session_returns_a_valid_session(session_root):
    site_id = "3f8a2c1e-9b4d-4e7a-8c2f-1d5e6a7b8c9d"
    write_session(session_root, {"token": "tkn", "expires_at": NOW_MS + 60000, "site_id": site_id})
    assert read_session(session_root / ".dropcowboy" / "session.json", NOW_MS)["token"] == "tkn"


@pytest.mark.parametrize(
    "content, expected",
    [
        (None, "404 session_not_found"),
        ({"token": "tkn", "expires_at": NOW_MS}, "410 session_expired"),
        ({"token": "tkn", "expires_at": NOW_MS // 1000 + 60}, "500 session_invalid"),
        ({"token": "tkn", "expires_at": True}, "500 session_invalid"),
        ({"token": "tkn", "expires_at": "2026-10-02T17:00:00Z"}, "500 session_invalid"),
        ({"expires_at": NOW_MS + 60000}, "500 session_invalid"),
        ({"token": "", "expires_at": NOW_MS + 60000}, "500 session_invalid"),
        ("[]", "500 session_invalid"),
        ("not json", "500 session_invalid"),
    ],
)
def test_read_session_maps_each_failure_to_its_status_and_code(session_root, content, expected):
    if content is not None:
        write_session(session_root, content)
    with pytest.raises(HttpError) as raised:
        read_session(session_root / ".dropcowboy" / "session.json", NOW_MS)
    assert str(raised.value.status) + " " + raised.value.code == expected
