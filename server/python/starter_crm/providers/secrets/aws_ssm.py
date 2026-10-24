"""The ``aws-ssm`` secrets provider: AWS Systems Manager Parameter Store, one path.

Where it sits: ``DC_SECRETS=aws-ssm``. Each starter secret is a parameter named ``<path>/<NAME>``, for example
``/starter-crm/DROPCOWBOY_API_KEY``, created as a ``SecureString``. The provider reads the path with decryption and
keeps only the names the starter asks for. boto3 finds its credentials itself, so on ECS the task role needs
``ssm:GetParametersByPath`` on that path (and ``kms:Decrypt`` when you use your own key). The Node server has the
same provider.

CONTRACT.md: "Providers" (secrets).
Env: DC_AWS_SSM_PATH (such as /starter-crm) and AWS_REGION. What a customer changes: nothing.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from ...aws_util import client_config, describe_aws_error, http_status, validate_aws
from ...problems import BootProblem, problem
from ._http import ManagerError, pick

name = "aws-ssm"
config_keys = ["DC_AWS_SSM_PATH", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_SSM"]

# What a Parameter Store path may look like: "/" then segments of letters, digits and "_.-".
_SSM_PATH = re.compile(r"^/([A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+$")


def _path_of(env: Mapping[str, str]) -> str:
    """The configured path without a trailing slash."""
    return (env.get("DC_AWS_SSM_PATH") or "").strip().rstrip("/")


def validate(env: Mapping[str, str]) -> list[BootProblem]:
    """Checks the path and the region.

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    problems = validate_aws(env, "DC_SECRETS=aws-ssm", "SSM")
    path = _path_of(env)
    if path == "":
        problems.append(
            problem(
                "missing_aws_ssm_path",
                "DC_SECRETS=aws-ssm needs DC_AWS_SSM_PATH.",
                "Set DC_AWS_SSM_PATH to the path that holds one SecureString parameter per secret, "
                "for example /starter-crm.",
            )
        )
    elif not _SSM_PATH.match(path):
        problems.append(
            problem(
                "invalid_aws_ssm_path",
                'DC_AWS_SSM_PATH must start with / and use letters, digits, "_", "." and "-" (got "' + path + '").',
                "Set it to a path such as /starter-crm or /apps/starter-crm.",
            )
        )
    return problems


class AwsSsm:
    """Reads the parameters under one Parameter Store path."""

    def __init__(self, env: Mapping[str, str], client: Any = None):
        """Prepares the provider; the client is built on first use.

        Args:
            env: The merged environment.
            client: A ready ``boto3.client("ssm")`` (tests).
        """
        self._env = env
        self._client = client
        self._path = _path_of(env)
        self._last_names: list[str] = []

    def _read(self, names: list[str]) -> dict:
        if self._client is None:
            # The SDK is only needed when this provider is chosen, so it is not imported at module load.
            import boto3

            self._client = boto3.client("ssm", **client_config(self._env, "SSM"))
        everything: dict[str, str] = {}
        token: str | None = None
        try:
            while True:
                arguments: dict[str, Any] = {"Path": self._path, "Recursive": False, "WithDecryption": True}
                if token:
                    arguments["NextToken"] = token
                page = self._client.get_parameters_by_path(**arguments)
                for parameter in page.get("Parameters", []):
                    leaf = str(parameter["Name"])[len(self._path) + 1 :]
                    if leaf and "/" not in leaf:
                        everything[leaf] = parameter["Value"]
                token = page.get("NextToken")
                if not token:
                    break
        except Exception as err:  # noqa: BLE001 - boto3 raises its own hierarchy; the message is rebuilt without the body
            raise ManagerError(
                describe_aws_error("AWS Parameter Store", err) + ' for "' + self._path + '"', http_status(err)
            ) from None
        return pick(everything, names)

    def load(self, names: list[str]) -> dict:
        """Reads the path and keeps the named parameters.

        Args:
            names: The secret names to look for.

        Returns:
            ``{NAME: value}`` for each parameter the path has.
        """
        self._last_names = list(names)
        return self._read(self._last_names)

    def refresh(self) -> dict:
        """Reads again the names the last ``load`` asked for.

        Returns:
            ``{NAME: value}`` as of now.
        """
        return self._read(self._last_names)


def create(ctx: Any, client: Any = None) -> AwsSsm:
    """Creates the provider.

    Args:
        ctx: The provider context; ``ctx.env`` holds the settings.
        client: A ready client, for tests.

    Returns:
        The instance.
    """
    return AwsSsm(ctx.env, client)
