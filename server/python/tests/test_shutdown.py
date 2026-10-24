"""``python -m starter_crm`` exits promptly on SIGTERM instead of waiting to be killed."""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest
from helpers import API_KEY, API_SECRET, SITE_ID, USER_ID

PYTHON_DIR = Path(__file__).resolve().parents[1]


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.mark.skipif(sys.platform == "win32", reason="needs POSIX signals")
def test_sigterm_ends_the_dev_server(tmp_path):
    port = free_port()
    env = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONPATH": str(PYTHON_DIR),
        "DC_AUTH_MODE": "server",
        "DROPCOWBOY_API_KEY": API_KEY,
        "DROPCOWBOY_API_SECRET": API_SECRET,
        "DROPCOWBOY_SITE_ID": SITE_ID,
        "STARTER_CRM_USER_ID": USER_ID,
        "STARTER_CRM_ROOT": str(tmp_path),
        "HOST": "127.0.0.1",
        "PORT": str(port),
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "starter_crm"],
        cwd=PYTHON_DIR,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1).close()
                break
            except OSError:
                time.sleep(0.1)
        else:
            pytest.fail("the server never answered /healthz")
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=5) == 0
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
