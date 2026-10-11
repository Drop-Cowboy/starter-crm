"""Serves the front-ends: ``vanilla/`` at ``/``, the built React app at ``/react/``
and the shared modules at ``/shared/``.

Outside ``/shared/``, paths that match no file fall back to ``index.html`` for
page loads, so client-side routes such as ``/setup`` survive a reload.
"""

from __future__ import annotations

import mimetypes
import os
from pathlib import Path
from typing import Callable

from flask import Response, redirect, request, send_file
from werkzeug.exceptions import NotFound
from werkzeug.security import safe_join

from .config import Config

# Some Windows registries map these to text/plain, and browsers then refuse
# to run the script or apply the stylesheet.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")

# Paths the static files never answer, even when no route matched them.
RESERVED_PREFIXES = ("/api", "/__dev", "/webhooks", "/healthz")

NO_VANILLA = "\n".join(
    [
        "The Starter CRM server is running, but there is no front-end to serve yet.",
        "",
        "Vanilla (no build step): the files in vanilla/ at the starter root are served here.",
        "React: cd react && npm install && npm run dev, then open http://localhost:5173/react/",
        "",
        "See README.md at the starter root.",
    ]
)

NO_REACT = "\n".join(
    [
        "The React app has not been built yet.",
        "",
        "Build it to serve it here:  cd react && npm install && npm run build",
        "Or run its dev server:      cd react && npm run dev, then open http://localhost:5173/react/",
    ]
)


class FrontEnd:
    """One front-end folder, mounted at a URL prefix."""

    def __init__(self, directory: Path, missing_text: str):
        self.directory = directory
        self.missing_text = missing_text

    def serve(self, relative_path: str):
        """Answers ``relative_path``: the part of the URL after the mount prefix.

        It starts with "/", or is empty when the URL is the prefix itself.
        """
        file = self._find(relative_path)
        if file is not None and os.path.isdir(file):
            # Like express.static: a folder without its trailing slash redirects,
            # so relative links inside its index.html resolve correctly.
            return redirect(request.path + "/", code=301)
        if file is not None:
            return send_file(file)

        index = self.directory / "index.html"
        if not index.exists():
            return Response(self.missing_text + "\n", content_type="text/plain; charset=utf-8")
        if "text/html" in (request.headers.get("Accept") or ""):
            return send_file(index)
        raise NotFound()

    def _find(self, relative_path: str) -> str | None:
        """The file to send, or None when nothing safe matches.

        ``safe_join`` refuses ``..`` and absolute paths, so nothing outside the
        folder is ever served. Names starting with "." (such as ``.env``) are
        skipped, as express.static does.
        """
        if relative_path == "":
            # The mount itself without its slash, such as /react.
            return str(self.directory) if self.directory.is_dir() else None
        name = relative_path.lstrip("/")
        if name == "" or name.endswith("/"):
            name += "index.html"
        if any(part.startswith(".") for part in name.split("/")):
            return None
        file = safe_join(str(self.directory), name)
        if file is None or not os.path.exists(file):
            return None
        return file


def serve_shared(directory: Path, relative_path: str):
    """``/shared/...``: the ES modules the no-build front-end imports.

    Files only: no index page, no listing and no fallback, so a missing module
    is a plain 404. Dotfiles and ``..`` are refused as in ``FrontEnd._find``. A
    backslash is a path separator on Windows alone, so it is refused everywhere.
    """
    name = relative_path.lstrip("/")
    if "\\" in name or any(part.startswith(".") for part in name.split("/")):
        raise NotFound()
    file = safe_join(str(directory), name)
    if file is None or not os.path.isfile(file):
        raise NotFound()
    return send_file(file)


def static_view(config: Config) -> Callable:
    react = FrontEnd(config.root / "react" / "dist", NO_REACT)
    vanilla = FrontEnd(config.root / "vanilla", NO_VANILLA)

    def serve_front_end(subpath: str):
        path = "/" + subpath
        if _under(path, RESERVED_PREFIXES):
            raise NotFound()
        if _under(path, ("/shared",)):
            return serve_shared(config.root / "shared", path[len("/shared") :])
        if _under(path, ("/react",)):
            return react.serve(path[len("/react") :])
        return vanilla.serve(path)

    return serve_front_end


def _under(path: str, prefixes: tuple[str, ...]) -> bool:
    """True when ``path`` is one of ``prefixes`` or inside one. "/apix" is not under "/api"."""
    return any(path == prefix or path.startswith(prefix + "/") for prefix in prefixes)
