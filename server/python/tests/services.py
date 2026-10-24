"""Where the real Postgres and Valkey from ``tests/services.compose.yml`` listen, and whether anything is there.

The suites that need them skip, with a reason, when nothing answers, so a run without Docker is still green.
"""

from __future__ import annotations

import os
import socket
import uuid
from urllib.parse import urlparse

POSTGRES_URL = os.environ.get(
    "STARTER_TEST_DATABASE_URL", "postgres://starter:starter-crm-dev@127.0.0.1:55432/starter_crm"
)
REDIS_URL = os.environ.get("STARTER_TEST_REDIS_URL", "redis://127.0.0.1:56379")
REDIS_CLUSTER_URL = os.environ.get("STARTER_TEST_REDIS_CLUSTER_URL", "redis://127.0.0.1:55380")
DYNAMODB_URL = os.environ.get("STARTER_TEST_DYNAMODB_URL", "http://127.0.0.1:58000")
SQS_URL = os.environ.get("STARTER_TEST_SQS_URL", "http://127.0.0.1:59324")
QSTASH_URL = os.environ.get("STARTER_TEST_QSTASH_URL", "http://127.0.0.1:58080")

# The credentials the QStash development server prints at startup: the same on every machine, and they open nothing.
QSTASH_DEV = {
    "QSTASH_URL": QSTASH_URL,
    "QSTASH_TOKEN": "eyJVc2VySUQiOiJkZWZhdWx0VXNlciIsIlBhc3N3b3JkIjoiZGVmYXVsdFBhc3N3b3JkIn0=",
    "QSTASH_CURRENT_SIGNING_KEY": "sig_" + "7kYjw48mhY7kAjqNGcy6cr29RJ6r",
    "QSTASH_NEXT_SIGNING_KEY": "sig_" + "5ZB6DVzB1wjE8S6rZ7eenA8Pdnhs",
}


def aws_test_env(**extra: str) -> dict[str, str]:
    """The settings that point boto3 at the local stand-ins (dynamodb-local, ElasticMQ).

    The credentials are dummies: neither stand-in checks them.

    Args:
        extra: Variables to add or override.

    Returns:
        An environment mapping.
    """
    env = {
        "AWS_REGION": "us-east-1",
        "AWS_ACCESS_KEY_ID": "test",
        "AWS_SECRET_ACCESS_KEY": "test",
        "AWS_ENDPOINT_URL_DYNAMODB": DYNAMODB_URL,
        "AWS_ENDPOINT_URL_SQS": SQS_URL,
        "DC_DYNAMODB_AUTO_CREATE": "on",
    }
    env.update(extra)
    return env


def reachable(url: str) -> bool:
    """Tries a TCP connection.

    Args:
        url: A service URL.

    Returns:
        True when something accepts connections there.
    """
    parsed = urlparse(url)
    try:
        with socket.create_connection((parsed.hostname, parsed.port), timeout=1):
            return True
    except OSError:
        return False


HAVE_POSTGRES = reachable(POSTGRES_URL)
HAVE_REDIS = reachable(REDIS_URL)
HAVE_REDIS_CLUSTER = reachable(REDIS_CLUSTER_URL)
HAVE_DYNAMODB = reachable(DYNAMODB_URL)
HAVE_SQS = reachable(SQS_URL)
HAVE_QSTASH = reachable(QSTASH_URL)


def fresh_site() -> str:
    """A new site id, so suites sharing one database never see each other's events.

    Returns:
        A random UUID.
    """
    return str(uuid.uuid4())
