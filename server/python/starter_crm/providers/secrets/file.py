"""The ``file`` secrets provider: one file per secret in a folder.

Where it sits: ``DC_SECRETS=file`` with ``DC_SECRETS_DIR``. This is the shape
Docker secrets and Kubernetes mounted secrets have: ``/run/secrets/<NAME>``
holds the value of ``<NAME>``. Surrounding whitespace is trimmed.

CONTRACT.md: "Providers" (secrets).
What a customer changes: nothing.
"""

from __future__ import annotations

import os
import re
import stat
from pathlib import Path

from ...problems import BootProblem, problem

name = "file"
config_keys = ["DC_SECRETS_DIR"]

# Only names shaped like environment variables are read, so a name can never walk out of the folder.
SAFE_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def validate(env) -> list[BootProblem]:
    """Checks ``DC_SECRETS_DIR`` is set and is a readable folder.

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    directory = (env.get("DC_SECRETS_DIR") or "").strip()
    fix = "Set DC_SECRETS_DIR to the folder holding one file per secret, such as /run/secrets."
    if not directory:
        return [problem("missing_secrets_dir", "DC_SECRETS=file needs DC_SECRETS_DIR.", fix)]
    path = Path(directory)
    if not path.is_dir() or not os.access(path, os.R_OK):
        return [problem("missing_secrets_dir", "DC_SECRETS_DIR (" + directory + ") is not a readable folder.", fix)]
    return []


class FileSecrets:
    """Reads ``<dir>/<NAME>`` for each name it is asked for."""

    def __init__(self, directory: Path, log):
        """Creates the provider.

        Args:
            directory: The folder holding the secret files.
            log: Logger for the world-readable warning.
        """
        self._dir = directory
        self._log = log
        self._last_names: list[str] = []
        self._warned: set[str] = set()

    def load(self, names: list[str]) -> dict:
        """Reads the named secrets.

        Args:
            names: The secret names to look for.

        Returns:
            ``{NAME: value}`` for each name that has a non-empty file.
        """
        self._last_names = list(names)
        return self._read(self._last_names)

    def refresh(self) -> dict:
        """Reads again the names the last ``load`` asked for.

        Returns:
            ``{NAME: value}`` as of now.
        """
        return self._read(self._last_names)

    def _read(self, names: list[str]) -> dict:
        values = {}
        for secret_name in names:
            if not SAFE_NAME.fullmatch(secret_name):
                continue
            file = self._dir / secret_name
            try:
                mode = file.stat().st_mode
            except OSError:
                continue
            if not stat.S_ISREG(mode):
                continue
            # Others being able to read a secret is worth saying once per file.
            if mode & stat.S_IROTH and str(file) not in self._warned:
                self._warned.add(str(file))
                self._log.warn("Secret file " + str(file) + " is world-readable. Restrict it, for example chmod 600.")
            try:
                value = file.read_text(encoding="utf-8").strip()
            except OSError:
                continue
            if value:
                values[secret_name] = value
        return values


def create(ctx) -> FileSecrets:
    """Creates the provider.

    Args:
        ctx: The provider context; ``ctx.env["DC_SECRETS_DIR"]`` is the folder.

    Returns:
        The instance.
    """
    return FileSecrets(Path(ctx.env["DC_SECRETS_DIR"].strip()).resolve(), ctx.log)
