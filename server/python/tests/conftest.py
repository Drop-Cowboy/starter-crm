from __future__ import annotations

import pytest
from helpers import FakeUpstream


@pytest.fixture
def upstream():
    """A fake Drop Cowboy API for one test. See helpers.FakeUpstream."""
    fake = FakeUpstream()
    yield fake
    fake.close()
