"""Shared AWS plumbing for the DynamoDB store and data provider, the SQS webhook mode and the AWS secrets providers.

Where it sits: every provider that talks to AWS reads its region, endpoint and table name through here, so they agree
on the environment variables, the table's shape and the TLS rule. The Node server has the same file (``src/aws.js``)
and the same table layout, which is what lets a Node and a Python server share one table and one queue.

Credentials are never read here: boto3 finds them itself (an ECS task role, a profile, or the ``AWS_ACCESS_KEY_ID``
pair). The starter never asks for an access key in its own settings.

The one table: the store (events) and the data provider (module documents) share a single DynamoDB table with a
string partition key ``pk``, a string sort key ``sk``, two global secondary indexes (``gsi1``, ``gsi2``, each a string
``gsi1pk``/``gsi1sk``, ``gsi2pk``/``gsi2sk``) and a time-to-live attribute ``expires_at``. ``TABLE_SPEC`` below is that
shape; the CloudFormation template creates the same table, and a test compares the two so they cannot drift.

CONTRACT.md: "Providers" (store, data, secrets, webhooks).
Env: AWS_REGION, AWS_ENDPOINT_URL (a local stand-in), DC_DYNAMODB_TABLE, DC_DYNAMODB_AUTO_CREATE.
What a customer changes: nothing.
"""

from __future__ import annotations

import contextlib
import re
from collections.abc import Mapping
from decimal import Decimal
from typing import Any
from urllib.parse import urlsplit

from .problems import BootProblem, problem
from .tls import allows_plaintext

# The names a table may have: DynamoDB's own rule, 3 to 255 letters, digits, underscore, dot and dash.
_TABLE_NAME = re.compile(r"^[A-Za-z0-9_.-]{3,255}$")

# Hosts a plain-HTTP endpoint is accepted on in production: this machine only.
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")

# The table's shape. The CloudFormation template must match it.
TABLE_SPEC = {
    "keys": [("pk", "HASH"), ("sk", "RANGE")],
    "indexes": [("gsi1", "gsi1pk", "gsi1sk"), ("gsi2", "gsi2pk", "gsi2sk")],
    "ttl_attribute": "expires_at",
}


def _clean(env: Mapping[str, str], key: str) -> str | None:
    """Reads a setting, trimmed, treating blank as unset."""
    value = env.get(key)
    return value.strip() if isinstance(value, str) and value.strip() != "" else None


def aws_region(env: Mapping[str, str]) -> str | None:
    """Reads the AWS region.

    Args:
        env: The merged environment.

    Returns:
        ``AWS_REGION``, else ``AWS_DEFAULT_REGION``, else None.
    """
    return _clean(env, "AWS_REGION") or _clean(env, "AWS_DEFAULT_REGION")


def aws_endpoint(env: Mapping[str, str], service: str) -> str | None:
    """Reads the endpoint override a local stand-in (dynamodb-local, ElasticMQ) is reached on.

    Args:
        env: The merged environment.
        service: The SDK's service suffix, such as ``DYNAMODB`` or ``SQS``.

    Returns:
        ``AWS_ENDPOINT_URL_<SERVICE>``, else ``AWS_ENDPOINT_URL``, else None.
    """
    return _clean(env, "AWS_ENDPOINT_URL_" + service) or _clean(env, "AWS_ENDPOINT_URL")


def validate_aws(env: Mapping[str, str], needs: str, service: str) -> list[BootProblem]:
    """Checks that a region is set and, in production, that no endpoint override sends traffic over plain HTTP.

    Args:
        env: The merged environment.
        needs: What needs AWS, for the message, such as ``DC_STORE=dynamodb``.
        service: The SDK's service suffix, such as ``DYNAMODB``.

    Returns:
        Boot problems (none when the settings are fine).
    """
    problems: list[BootProblem] = []
    if not aws_region(env):
        problems.append(
            problem(
                "missing_aws_region",
                needs + " needs AWS_REGION.",
                "Set AWS_REGION to the region your resources are in, such as us-east-1. ECS sets it for you.",
            )
        )
    endpoint = aws_endpoint(env, service)
    if endpoint:
        parts = None
        try:
            parts = urlsplit(endpoint)
            hostname = parts.hostname
            if parts.scheme not in ("http", "https") or not hostname:
                raise ValueError("not a URL")
        except ValueError:
            parts = None
            problems.append(
                problem(
                    "invalid_aws_endpoint",
                    'AWS_ENDPOINT_URL is not a URL (got "' + endpoint + '").',
                    "Leave it unset to use AWS, or set it to the address of a local stand-in such as http://127.0.0.1:8000.",
                )
            )
        if (
            parts is not None
            and env.get("DC_ENV") == "production"
            and parts.scheme != "https"
            and parts.hostname not in LOCAL_HOSTS
            and not allows_plaintext(env)
        ):
            problems.append(
                problem(
                    "insecure_aws_endpoint",
                    "AWS_ENDPOINT_URL must use https:// in production.",
                    "Unset AWS_ENDPOINT_URL to use AWS, or use https://. Localhost is exempt, and so is a private "
                    "network you control when DC_INSECURE_PRIVATE_SERVICES=on.",
                )
            )
    return problems


def dynamo_table(env: Mapping[str, str]) -> str:
    """The table the store and data provider use.

    Args:
        env: The merged environment.

    Returns:
        ``DC_DYNAMODB_TABLE``, default ``starter-crm``.
    """
    return _clean(env, "DC_DYNAMODB_TABLE") or "starter-crm"


def validate_table(env: Mapping[str, str]) -> list[BootProblem]:
    """Checks the table name.

    Args:
        env: The merged environment.

    Returns:
        Boot problems.
    """
    name = dynamo_table(env)
    if not _TABLE_NAME.match(name):
        return [
            problem(
                "invalid_dynamodb_table",
                'DC_DYNAMODB_TABLE is not a valid table name (got "' + name + '").',
                "Use 3 to 255 letters, digits, underscores, dots and dashes, or leave it unset for starter-crm.",
            )
        ]
    return []


def auto_create(env: Mapping[str, str]) -> bool:
    """Whether the server may create the table when it is missing.

    Off by default: the CloudFormation template creates the table, and a task role that can create tables is more
    permission than a running server needs. Turn it on for a local stand-in.

    Args:
        env: The merged environment.

    Returns:
        True for ``on``, ``1`` or ``true``.
    """
    return str(env.get("DC_DYNAMODB_AUTO_CREATE") or "").strip().lower() in ("on", "1", "true")


def client_config(env: Mapping[str, str], service: str) -> dict[str, Any]:
    """The keyword arguments every boto3 client here is built with.

    Args:
        env: The merged environment.
        service: The SDK's service suffix, such as ``DYNAMODB``, ``SQS``, ``SECRETS_MANAGER`` or ``SSM``.

    Returns:
        ``region_name`` and ``endpoint_url`` when set, plus a retry and timeout policy. Credentials in the merged
        environment (``AWS_ACCESS_KEY_ID`` and ``AWS_SECRET_ACCESS_KEY``, and ``AWS_SESSION_TOKEN``) are passed on,
        because boto3 itself reads only the process environment, not a ``.env`` file; otherwise boto3 finds them.
    """
    # The SDK is only needed when an AWS provider is chosen, so it is not imported at module load.
    from botocore.config import Config

    config: dict[str, Any] = {
        "config": Config(retries={"max_attempts": 3, "mode": "standard"}, connect_timeout=5, read_timeout=30),
    }
    region = aws_region(env)
    if region:
        config["region_name"] = region
    endpoint = aws_endpoint(env, service)
    if endpoint:
        config["endpoint_url"] = endpoint
    key = str(env.get("AWS_ACCESS_KEY_ID") or "").strip()
    secret = str(env.get("AWS_SECRET_ACCESS_KEY") or "").strip()
    if key and secret:
        config["aws_access_key_id"] = key
        config["aws_secret_access_key"] = secret
        token = str(env.get("AWS_SESSION_TOKEN") or "").strip()
        if token:
            config["aws_session_token"] = token
    return config


def describe_aws_error(label: str, err: BaseException) -> str:
    """Says what went wrong with an AWS call without echoing anything the call carried.

    Args:
        label: The service, such as ``AWS Secrets Manager``.
        err: What boto3 raised.

    Returns:
        For example ``AWS Secrets Manager answered HTTP 403 (AccessDeniedException)``, or ``... could not be reached``.
    """
    response = getattr(err, "response", None)
    if isinstance(response, dict):
        status = (response.get("ResponseMetadata") or {}).get("HTTPStatusCode")
        if status:
            code = (response.get("Error") or {}).get("Code")
            return label + " answered HTTP " + str(status) + (" (" + str(code) + ")" if code else "")
    return label + " could not be reached"


def http_status(err: BaseException) -> int | None:
    """The HTTP status of a service answer carried by a boto3 error.

    Args:
        err: What boto3 raised.

    Returns:
        The status, or None when there was no answer.
    """
    response = getattr(err, "response", None)
    if isinstance(response, dict):
        status = (response.get("ResponseMetadata") or {}).get("HTTPStatusCode")
        return int(status) if status else None
    return None


def error_code(err: BaseException) -> str | None:
    """The AWS error code of a boto3 ``ClientError``, such as ``ConditionalCheckFailedException``.

    Args:
        err: What boto3 raised.

    Returns:
        The code, or None when the error did not come from a service answer.
    """
    response = getattr(err, "response", None)
    if isinstance(response, dict):
        code = (response.get("Error") or {}).get("Code")
        return str(code) if code else None
    return None


def pad(ms: int | float) -> str:
    """A fixed-width sort-key piece for a time, so keys sort the way the times do.

    Args:
        ms: Epoch milliseconds (0 up to 9999999999999).

    Returns:
        The number as 13 digits, left-padded with zeros.
    """
    return str(max(0, int(ms))).rjust(13, "0")


def to_dynamo(value: Any) -> Any:
    """Turns a JSON-shaped Python value into one DynamoDB's serializer takes (floats become ``Decimal``).

    Args:
        value: A value made of dicts, lists, strings, numbers, booleans and None.

    Returns:
        The same value with every float replaced by a ``Decimal``.
    """
    if isinstance(value, bool) or value is None or isinstance(value, (str, int)):
        return value
    if isinstance(value, float):
        return Decimal(repr(value))
    if isinstance(value, dict):
        return {key: to_dynamo(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_dynamo(item) for item in value]
    return value


def from_dynamo(value: Any) -> Any:
    """Turns what DynamoDB's deserializer returns back into plain JSON values (``Decimal`` becomes int or float).

    Args:
        value: A deserialized DynamoDB value.

    Returns:
        The value with each ``Decimal`` replaced by an ``int`` when it is whole, else a ``float``.
    """
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {key: from_dynamo(item) for key, item in value.items()}
    if isinstance(value, list):
        return [from_dynamo(item) for item in value]
    return value


class DynamoClient:
    """A DynamoDB client that takes and returns plain Python values, with the table name filled in.

    boto3's low-level client speaks in typed attribute values (``{"S": "x"}``). This wraps the handful of calls the
    starter needs and converts both ways, so the store and the data provider read like the Node versions.
    """

    def __init__(self, raw: Any, table: str):
        """Wraps a boto3 DynamoDB client.

        Args:
            raw: A ``boto3.client("dynamodb")``.
            table: The table name.
        """
        from boto3.dynamodb.types import TypeDeserializer, TypeSerializer

        self.raw = raw
        self.table = table
        self._ser = TypeSerializer()
        self._de = TypeDeserializer()

    def _pack(self, values: dict | None) -> dict | None:
        if not values:
            return None
        return {key: self._ser.serialize(to_dynamo(value)) for key, value in values.items()}

    def _unpack(self, item: dict | None) -> dict | None:
        if item is None:
            return None
        return {key: from_dynamo(self._de.deserialize(value)) for key, value in item.items()}

    def _expression(self, kwargs: dict, names: dict | None, values: dict | None) -> dict:
        if names:
            kwargs["ExpressionAttributeNames"] = names
        packed = self._pack(values)
        if packed:
            kwargs["ExpressionAttributeValues"] = packed
        return kwargs

    def get(self, key: dict, consistent: bool = True) -> dict | None:
        """Reads one item.

        Args:
            key: ``{"pk": ..., "sk": ...}``.
            consistent: Strongly consistent read (the default).

        Returns:
            The item, or None.
        """
        result = self.raw.get_item(TableName=self.table, Key=self._pack(key), ConsistentRead=consistent)
        return self._unpack(result.get("Item"))

    def put(self, item: dict, condition: str | None = None) -> None:
        """Writes one item.

        Args:
            item: The item.
            condition: An optional condition expression; a failed one raises ``ConditionalCheckFailedException``.
        """
        kwargs: dict[str, Any] = {"TableName": self.table, "Item": self._pack(item)}
        if condition:
            kwargs["ConditionExpression"] = condition
        self.raw.put_item(**kwargs)

    def update(
        self,
        key: dict,
        expression: str,
        names: dict | None = None,
        values: dict | None = None,
        condition: str | None = None,
        return_values: str | None = None,
    ) -> dict | None:
        """Updates one item.

        Args:
            key: ``{"pk": ..., "sk": ...}``.
            expression: The update expression.
            names: ``ExpressionAttributeNames``.
            values: ``ExpressionAttributeValues`` as plain values.
            condition: An optional condition expression.
            return_values: ``ALL_NEW``, ``UPDATED_NEW`` and so on.

        Returns:
            The returned attributes, when ``return_values`` was given.
        """
        kwargs: dict[str, Any] = {"TableName": self.table, "Key": self._pack(key), "UpdateExpression": expression}
        if condition:
            kwargs["ConditionExpression"] = condition
        if return_values:
            kwargs["ReturnValues"] = return_values
        result = self.raw.update_item(**self._expression(kwargs, names, values))
        return self._unpack(result.get("Attributes"))

    def query(
        self,
        key_condition: str,
        values: dict,
        names: dict | None = None,
        index: str | None = None,
        forward: bool = True,
        limit: int | None = None,
        consistent: bool = False,
        count_only: bool = False,
    ) -> list[dict] | int:
        """Queries a partition, following pages.

        Args:
            key_condition: The key condition expression.
            values: Its values as plain values.
            names: ``ExpressionAttributeNames``.
            index: An index name, or None for the table.
            forward: Ascending sort-key order (False for newest first).
            limit: Stop after this many items.
            consistent: Strongly consistent (not allowed on an index).
            count_only: Return the number of items instead of the items.

        Returns:
            The items, or their count.
        """
        items: list[dict] = []
        total = 0
        start: dict | None = None
        while True:
            kwargs: dict[str, Any] = {
                "TableName": self.table,
                "KeyConditionExpression": key_condition,
                "ScanIndexForward": forward,
            }
            if index:
                kwargs["IndexName"] = index
            if consistent:
                kwargs["ConsistentRead"] = True
            if count_only:
                kwargs["Select"] = "COUNT"
            if limit is not None and not count_only:
                kwargs["Limit"] = limit - len(items)
            if start:
                kwargs["ExclusiveStartKey"] = start
            page = self.raw.query(**self._expression(kwargs, names, values))
            total += page.get("Count", 0)
            for item in page.get("Items", []):
                items.append(self._unpack(item))
            start = page.get("LastEvaluatedKey")
            if not start or (limit is not None and not count_only and len(items) >= limit):
                break
        return total if count_only else items

    def query_page(
        self,
        key_condition: str,
        values: dict,
        index: str,
        forward: bool = True,
        start: dict | None = None,
    ) -> tuple[list[dict], dict | None]:
        """Reads one page of an index partition.

        Args:
            key_condition: The key condition expression.
            values: Its values as plain values.
            index: The index name.
            forward: Ascending sort-key order (False for newest first).
            start: The ``next_start`` of the previous page, or None for the first.

        Returns:
            The page's items and an opaque cursor for the next page (None on the last page).
        """
        kwargs: dict[str, Any] = {
            "TableName": self.table,
            "IndexName": index,
            "KeyConditionExpression": key_condition,
            "ScanIndexForward": forward,
        }
        if start:
            kwargs["ExclusiveStartKey"] = start
        page = self.raw.query(**self._expression(kwargs, None, values))
        return [self._unpack(item) for item in page.get("Items", [])], page.get("LastEvaluatedKey")

    def delete_keys(self, keys: list[dict]) -> None:
        """Deletes items by key, 25 at a time, retrying what DynamoDB sends back.

        Args:
            keys: ``{"pk": ..., "sk": ...}`` for each item.
        """
        import time

        for i in range(0, len(keys), 25):
            requests = [
                {"DeleteRequest": {"Key": self._pack({"pk": k["pk"], "sk": k["sk"]})}} for k in keys[i : i + 25]
            ]
            for attempt in range(7):
                result = self.raw.batch_write_item(RequestItems={self.table: requests})
                requests = (result.get("UnprocessedItems") or {}).get(self.table, [])
                if not requests:
                    break
                if attempt >= 5:
                    raise RuntimeError("DynamoDB would not delete " + str(len(requests)) + " item(s) after 6 tries.")
                time.sleep(0.05 * 2**attempt)

    def batch_get(self, keys: list[dict]) -> dict[tuple[str, str], dict]:
        """Reads items by key, strongly consistent, 100 at a time.

        Args:
            keys: ``{"pk": ..., "sk": ...}`` for each item.

        Returns:
            The items found, by ``(pk, sk)``.
        """
        import time

        found: dict[tuple[str, str], dict] = {}
        for i in range(0, len(keys), 100):
            request: dict | None = {
                "Keys": [self._pack({"pk": k["pk"], "sk": k["sk"]}) for k in keys[i : i + 100]],
                "ConsistentRead": True,
            }
            for attempt in range(7):
                result = self.raw.batch_get_item(RequestItems={self.table: request})
                for raw_item in (result.get("Responses") or {}).get(self.table, []):
                    item = self._unpack(raw_item)
                    found[(item["pk"], item["sk"])] = item
                request = (result.get("UnprocessedKeys") or {}).get(self.table)
                if not request:
                    break
                if attempt >= 5:
                    raise RuntimeError("DynamoDB would not return every document after 6 tries.")
                time.sleep(0.05 * 2**attempt)
        return found

    def transact(self, operations: list[dict]) -> None:
        """Runs several writes as one transaction.

        Args:
            operations: Each ``{"put": item, "condition": expr}`` or ``{"delete": key, "condition": expr}``.
        """
        items = []
        for op in operations:
            if "put" in op:
                entry: dict[str, Any] = {"TableName": self.table, "Item": self._pack(op["put"])}
                if op.get("condition"):
                    entry["ConditionExpression"] = op["condition"]
                items.append({"Put": entry})
            else:
                entry = {"TableName": self.table, "Key": self._pack(op["delete"])}
                if op.get("condition"):
                    entry["ConditionExpression"] = op["condition"]
                items.append({"Delete": entry})
        self.raw.transact_write_items(TransactItems=items)

    def ensure_table(self, create: bool) -> None:
        """Creates the table (and waits until it is ready) when it does not exist and ``create`` is true.

        Args:
            create: Whether this server may create it (``DC_DYNAMODB_AUTO_CREATE``).

        Raises:
            RuntimeError: When the table is missing and may not be created, naming the setting that fixes it.
        """
        try:
            self.raw.describe_table(TableName=self.table)
            return
        except Exception as err:  # noqa: BLE001 - only "not found" is handled; anything else is raised
            if error_code(err) != "ResourceNotFoundException":
                raise
            if not create:
                raise RuntimeError(
                    'The DynamoDB table "' + self.table + '" does not exist. Create it with the CloudFormation '
                    "template (deploy/aws), or set DC_DYNAMODB_AUTO_CREATE=on to let the server create it."
                ) from None
        attributes: list[str] = []
        for key, _ in TABLE_SPEC["keys"]:
            attributes.append(key)
        for _, hash_key, range_key in TABLE_SPEC["indexes"]:
            attributes.extend([hash_key, range_key])
        try:
            self.raw.create_table(
                TableName=self.table,
                BillingMode="PAY_PER_REQUEST",
                AttributeDefinitions=[
                    {"AttributeName": name, "AttributeType": "S"} for name in dict.fromkeys(attributes)
                ],
                KeySchema=[{"AttributeName": name, "KeyType": kind} for name, kind in TABLE_SPEC["keys"]],
                GlobalSecondaryIndexes=[
                    {
                        "IndexName": index,
                        "KeySchema": [
                            {"AttributeName": hash_key, "KeyType": "HASH"},
                            {"AttributeName": range_key, "KeyType": "RANGE"},
                        ],
                        "Projection": {"ProjectionType": "ALL"},
                    }
                    for index, hash_key, range_key in TABLE_SPEC["indexes"]
                ],
            )
        except Exception as err:  # noqa: BLE001 - another instance may have created it a moment ago
            if error_code(err) != "ResourceInUseException":
                raise
        self.raw.get_waiter("table_exists").wait(TableName=self.table, WaiterConfig={"Delay": 1, "MaxAttempts": 60})
        # Some local stand-ins lack TTL; the store prunes expired events itself, so the table works without it.
        with contextlib.suppress(Exception):
            self.raw.update_time_to_live(
                TableName=self.table,
                TimeToLiveSpecification={"Enabled": True, "AttributeName": TABLE_SPEC["ttl_attribute"]},
            )

    def table_active(self) -> bool:
        """Whether the table exists and is usable.

        Returns:
            True for an ``ACTIVE`` or ``UPDATING`` table; False for anything else or any error.
        """
        try:
            status = self.raw.describe_table(TableName=self.table)["Table"]["TableStatus"]
            return status in ("ACTIVE", "UPDATING")
        except Exception:  # noqa: BLE001 - any client error means not ready
            return False


def connect_dynamo(env: Mapping[str, str]) -> DynamoClient:
    """Opens a DynamoDB client.

    Args:
        env: The merged environment.

    Returns:
        The wrapped client, for the table ``dynamo_table(env)``.
    """
    import boto3

    kwargs = client_config(env, "DYNAMODB")
    return DynamoClient(boto3.client("dynamodb", **kwargs), dynamo_table(env))
