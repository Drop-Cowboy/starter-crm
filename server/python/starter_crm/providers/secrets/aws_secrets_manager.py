"""The ``aws-secrets-manager`` secrets provider: AWS Secrets Manager, one JSON secret.

Where it sits: ``DC_SECRETS=aws-secrets-manager``. One secret holds a JSON object with one field per starter secret
(``DROPCOWBOY_API_KEY``, and so on); the provider reads its current version and keeps only the names the starter asks
for. boto3 finds its credentials itself, so on ECS the task role needs ``secretsmanager:GetSecretValue`` on that one
secret and nothing else. The Node server has the same provider.

CONTRACT.md: "Providers" (secrets).
Env: DC_AWS_SECRET_ID (the secret's name or ARN) and AWS_REGION. What a customer changes: nothing.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from ...aws_util import client_config, describe_aws_error, http_status, validate_aws
from ...problems import BootProblem, problem
from ._http import ManagerError, pick

name = "aws-secrets-manager"
config_keys = [
    "DC_AWS_SECRET_ID",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_ENDPOINT_URL",
    "AWS_ENDPOINT_URL_SECRETS_MANAGER",
]


def validate(env: Mapping[str, str]) -> list[BootProblem]:
    """Checks the secret id and the region.

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    problems = validate_aws(env, "DC_SECRETS=aws-secrets-manager", "SECRETS_MANAGER")
    if not (env.get("DC_AWS_SECRET_ID") or "").strip():
        problems.append(
            problem(
                "missing_aws_secret_id",
                "DC_SECRETS=aws-secrets-manager needs DC_AWS_SECRET_ID.",
                "Set DC_AWS_SECRET_ID to the name or ARN of a secret whose value is a JSON object, "
                'such as {"DROPCOWBOY_API_KEY":"..."}.',
            )
        )
    return problems


class AwsSecretsManager:
    """Reads one JSON secret from AWS Secrets Manager."""

    def __init__(self, env: Mapping[str, str], client: Any = None):
        """Prepares the provider; the client is built on first use.

        Args:
            env: The merged environment.
            client: A ready ``boto3.client("secretsmanager")`` (tests).
        """
        self._env = env
        self._client = client
        self._secret_id = (env.get("DC_AWS_SECRET_ID") or "").strip()
        self._last_names: list[str] = []

    def _read(self, names: list[str]) -> dict:
        if self._client is None:
            # The SDK is only needed when this provider is chosen, so it is not imported at module load.
            import boto3

            self._client = boto3.client("secretsmanager", **client_config(self._env, "SECRETS_MANAGER"))
        try:
            result = self._client.get_secret_value(SecretId=self._secret_id)
        except Exception as err:  # noqa: BLE001 - boto3 raises its own hierarchy; the message is rebuilt without the body
            # The id is a setting, not a secret, so naming it makes a typo or a missing permission easy to see.
            raise ManagerError(
                describe_aws_error("AWS Secrets Manager", err) + ' for "' + self._secret_id + '"', http_status(err)
            ) from None
        not_json = ManagerError('The secret "' + self._secret_id + '" is not a JSON object of NAME: value pairs.')
        try:
            data = json.loads(result.get("SecretString") or "")
        except ValueError:
            raise not_json from None
        if not isinstance(data, dict):
            raise not_json
        return pick(data, names)

    def load(self, names: list[str]) -> dict:
        """Reads the secret and keeps the named fields.

        Args:
            names: The secret names to look for.

        Returns:
            ``{NAME: value}`` for each field the secret has.
        """
        self._last_names = list(names)
        return self._read(self._last_names)

    def refresh(self) -> dict:
        """Reads again the names the last ``load`` asked for.

        Returns:
            ``{NAME: value}`` as of now.
        """
        return self._read(self._last_names)


def create(ctx: Any, client: Any = None) -> AwsSecretsManager:
    """Creates the provider.

    Args:
        ctx: The provider context; ``ctx.env`` holds the settings.
        client: A ready client, for tests.

    Returns:
        The instance.
    """
    return AwsSecretsManager(ctx.env, client)
