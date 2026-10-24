"""Serves the front-ends.

``vanilla/`` is served at ``/``, the built React app at ``/react/`` and the
shared modules at ``/shared/``.

Outside ``/shared/``, paths that match no file fall back to ``index.html`` for
page loads, so client-side routes such as ``/setup`` survive a reload.
"""

from __future__ import annotations

import gzip
import mimetypes
import os
import re
import threading
from collections.abc import Callable
from pathlib import Path

from flask import Response, redirect, request, send_file
from werkzeug.exceptions import NotFound
from werkzeug.security import safe_join

from .config import Config

# Some Windows registries map these to text/plain, and browsers then refuse
# to run the script or apply the stylesheet.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/css", ".css")

# Content types worth compressing: text a browser reads, not images or fonts
# that are already compressed.
COMPRESSIBLE_TYPES = frozenset(
    {"text/html", "text/javascript", "text/css", "application/json", "image/svg+xml", "text/plain"}
)

# Below this size, gzip's header costs more than it saves.
MIN_COMPRESS_BYTES = 1024

# Files Vite writes into react/dist/assets/, whose names carry a content hash
# (index-BWradlQu.js). A changed file gets a new name, so the old name can be
# cached for a year without ever going stale.
HASHED_ASSET = re.compile(r"^/assets/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$")

# One year, the longest a cache is expected to honour.
IMMUTABLE_CACHE = "public, max-age=31536000, immutable"

# Compressed bodies by file and version, so each file is gzipped once, not on
# every request. Capped so a large folder cannot grow memory without limit.
GZIP_CACHE_LIMIT = 200
_gzip_cache: dict[tuple[str, int, int], bytes] = {}
_gzip_lock = threading.Lock()

# Paths the static files never answer, even when no route matched them.
RESERVED_PREFIXES = ("/api", "/__dev", "/webhooks", "/internal", "/healthz", "/readyz")

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

    def __init__(self, directory: Path, missing_text: str, immutable_assets: bool = False):
        """Records the folder and the message for when it is not built.

        Args:
            directory: Folder holding the front-end files.
            missing_text: Plain-text 404 body when ``directory`` is absent.
            immutable_assets: True for a build whose ``assets/`` files carry a content hash.
        """
        self.directory = directory
        self.missing_text = missing_text
        self.immutable_assets = immutable_assets

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
            # Only the React build's hashed asset files are immutable; the page itself never is.
            hashed = self.immutable_assets and HASHED_ASSET.match(relative_path) is not None
            return send_asset(file, immutable=hashed)

        index = self.directory / "index.html"
        if not index.exists():
            return Response(self.missing_text + "\n", content_type="text/plain; charset=utf-8")
        if "text/html" in (request.headers.get("Accept") or ""):
            return send_asset(index)
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
    return send_asset(file)


def accepts_gzip(header: str | None) -> bool:
    """Whether the browser said it can decode gzip.

    Args:
        header: The ``Accept-Encoding`` request header.

    Returns:
        True when ``gzip`` is listed and not refused with ``q=0``.
    """
    if not header:
        return False
    for part in header.split(","):
        name, *params = part.strip().split(";")
        if name.strip().lower() != "gzip":
            continue
        for item in params:
            item = item.strip().lower()
            if item.startswith("q="):
                try:
                    return float(item[2:]) > 0
                except ValueError:
                    return False
        return True
    return False


def _gzipped(file: str, body: bytes, stamp: tuple[int, int]) -> bytes:
    """The gzipped bytes of a file, from the cache when this version was seen.

    Args:
        file: Absolute path of the file.
        body: The file's bytes.
        stamp: Its size and modified time, which change whenever the file does.

    Returns:
        The compressed bytes.
    """
    key = (file, stamp[0], stamp[1])
    with _gzip_lock:
        cached = _gzip_cache.get(key)
    if cached is not None:
        return cached
    compressed = gzip.compress(body, compresslevel=6, mtime=0)
    with _gzip_lock:
        if len(_gzip_cache) >= GZIP_CACHE_LIMIT:
            _gzip_cache.pop(next(iter(_gzip_cache)))
        _gzip_cache[key] = compressed
    return compressed


def send_asset(file: str | Path, immutable: bool = False):
    """Sends one front-end file with the caching and compression rules.

    Caching: a hashed build asset is ``immutable`` for a year; everything else
    is ``no-cache``, so the browser may keep it but must ask before using it,
    and the ETag turns that question into a 304. A new deploy therefore shows
    up on the next page load, while the heavy assets are never fetched twice.

    Compression: text types of 1 KB or more are sent gzipped when the browser
    accepts it, with ``Vary: Accept-Encoding`` so a cache keeps both versions.

    Args:
        file: Absolute path of a regular file.
        immutable: True for a content-hashed file.

    Returns:
        The Flask response: 200 with the file, or 304 for a matching ETag.
    """
    response = send_file(file, conditional=True, max_age=None)
    response.headers["Cache-Control"] = IMMUTABLE_CACHE if immutable else "no-cache"
    content_type = (response.mimetype or "").split(";")[0]
    stat = os.stat(file)
    if content_type not in COMPRESSIBLE_TYPES or stat.st_size < MIN_COMPRESS_BYTES:
        return response
    response.headers["Vary"] = "Accept-Encoding"
    wants_gzip = accepts_gzip(request.headers.get("Accept-Encoding"))
    if response.status_code != 200 or not wants_gzip or "Range" in request.headers:
        return response
    with open(file, "rb") as handle:
        body = handle.read()
    compressed = _gzipped(str(file), body, (stat.st_size, int(stat.st_mtime_ns)))
    response.direct_passthrough = False
    response.set_data(compressed)
    response.headers["Content-Encoding"] = "gzip"
    response.headers["Content-Length"] = str(len(compressed))
    return response


def static_view(config: Config) -> Callable:
    """Builds the catch-all view for the front-ends.

    Args:
        config: The loaded server config; ``root`` locates the folders.

    Returns:
        A Flask view taking the URL subpath.
    """
    react = FrontEnd(config.root / "react" / "dist", NO_REACT, immutable_assets=True)
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
