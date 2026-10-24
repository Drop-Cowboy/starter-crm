"""Every module a process starts from imports cleanly on its own, in a fresh interpreter.

A circular import only shows when one module is loaded first, and pytest loads them in a different order from
``python -m starter_crm.worker``, so a cycle can pass every other test and still break a container.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1] / "starter_crm"
# wsgi.py builds the whole app when imported, so the conformance suite exercises it instead.
MODULES = sorted(
    "starter_crm." + ".".join(path.relative_to(PACKAGE).with_suffix("").parts)
    for path in PACKAGE.rglob("*.py")
    if path.name not in ("__init__.py", "__main__.py", "wsgi.py") and "__pycache__" not in path.parts
)


@pytest.mark.parametrize("module", ["starter_crm", *MODULES])
def test_a_module_imports_on_its_own(module):
    result = subprocess.run([sys.executable, "-c", "import " + module], capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr[-1500:]
