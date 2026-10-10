from __future__ import annotations

import pytest
from helpers import make_client, make_config

HTML = {"Accept": "text/html,application/xhtml+xml"}


@pytest.fixture
def client(tmp_path):
    (tmp_path / "vanilla").mkdir()
    (tmp_path / "vanilla" / "index.html").write_text("<!doctype html><!-- vanilla-index -->")
    (tmp_path / "vanilla" / "app.js").write_text("console.log('vanilla-asset');")
    (tmp_path / "vanilla" / ".hidden").write_text("hidden-dotfile")
    (tmp_path / "react" / "dist").mkdir(parents=True)
    (tmp_path / "react" / "dist" / "index.html").write_text("<!doctype html><!-- react-index -->")
    (tmp_path / "shared" / "lib").mkdir(parents=True)
    (tmp_path / "shared" / "dc-api.js").write_text('export const shared = "shared-module";')
    (tmp_path / "shared" / "lib" / "format.mjs").write_text('export const format = "nested-module";')
    (tmp_path / "shared" / ".hidden.js").write_text("hidden-dotfile")
    (tmp_path / ".env").write_text("DROPCOWBOY_API_KEY=never-served")
    return make_client(make_config(DC_AUTH_MODE="login", STARTER_CRM_ROOT=str(tmp_path)))


def test_serves_shared_modules_as_text_javascript(client):
    for path, marker in [("/shared/dc-api.js", "shared-module"), ("/shared/lib/format.mjs", "nested-module")]:
        response = client.get(path)
        assert response.status_code == 200
        assert response.headers["Content-Type"].startswith("text/javascript")
        assert marker in response.get_data(as_text=True)


@pytest.mark.parametrize(
    "path",
    [
        "/shared",
        "/shared/",
        "/shared/lib",
        "/shared/.hidden.js",
        "/shared/missing.js",
        "/shared/../.env",
        "/shared/%2e%2e/.env",
        "/shared/..%2f.env",
        "/shared/..\\.env",
        "/shared/..%5c.env",
        "/shared/lib\\format.mjs",
    ],
)
def test_shared_answers_404_for_folders_dotfiles_missing_files_and_escapes(client, path):
    response = client.get(path, headers=HTML)
    assert response.status_code == 404
    assert response.get_json()["error"]["code"] == "not_found"


def test_serves_index_and_assets(client):
    assert "vanilla-index" in client.get("/", headers=HTML).get_data(as_text=True)
    asset = client.get("/app.js")
    assert asset.status_code == 200
    assert "javascript" in asset.headers["Content-Type"]


def test_falls_back_to_index_html_for_page_loads_only(client):
    assert "vanilla-index" in client.get("/contacts/5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d", headers=HTML).get_data(
        as_text=True
    )
    missing = client.get("/missing.js", headers={"Accept": "application/json"})
    assert missing.status_code == 404
    assert missing.get_json()["error"]["code"] == "not_found"


def test_serves_react_under_its_prefix_and_redirects_the_bare_prefix(client):
    assert "react-index" in client.get("/react/", headers=HTML).get_data(as_text=True)
    assert "react-index" in client.get("/react/contacts", headers=HTML).get_data(as_text=True)
    bare = client.get("/react")
    assert bare.status_code == 301
    assert bare.headers["Location"].endswith("/react/")


def test_never_serves_dotfiles_or_files_outside_the_folder(client):
    for path in ["/.hidden", "/../.env", "/react/../../.env", "/%2e%2e/.env"]:
        text = client.get(path, headers=HTML).get_data(as_text=True)
        assert "hidden-dotfile" not in text
        assert "never-served" not in text


def test_reserved_prefixes_are_never_static(client):
    for path in ["/api", "/api/nothing", "/__dev/x", "/webhooks/x", "/healthz/x"]:
        response = client.get(path, headers=HTML)
        assert response.status_code == 404
        assert response.get_json()["error"]["code"] == "not_found"


def test_explains_how_to_start_a_front_end_when_there_is_none():
    client = make_client(make_config(DC_AUTH_MODE="login"))
    for path in ["/", "/react/", "/anything.js"]:
        response = client.get(path, headers=HTML)
        assert response.status_code == 200
        assert response.headers["Content-Type"].startswith("text/plain")
    assert "npm" in client.get("/react/").get_data(as_text=True)
