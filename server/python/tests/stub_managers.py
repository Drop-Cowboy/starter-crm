"""Stand-ins for Doppler, Infisical and Vault, for the secrets provider tests.

Same behaviour as server/conformance/lib/secret-managers.js, so the Python
provider is held to what the shared suite holds both servers to. Each stub
runs on a loopback port in a thread; ``stub.url`` is what the provider is
pointed at, ``stub.requests`` records every call, and ``stub.failing`` makes
every call answer that status.
"""

from __future__ import annotations

import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


class Stub:
    """One running stand-in."""

    def __init__(self, route):
        """Starts the server.

        Args:
            route: ``route(stub, method, path, query, headers, body)`` returning ``(status, payload)``.
        """
        self.requests: list[dict] = []
        self.failing: int | None = None
        self.secrets: dict[str, str] = {}
        self.logins = 0
        self.tokens: set[str] = set()
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def _serve(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length).decode("utf-8") if length else ""
                try:
                    body = json.loads(raw) if raw else None
                except ValueError:
                    body = None
                parts = urlsplit(self.path)
                query = {key: values[0] for key, values in parse_qs(parts.query).items()}
                headers = {key.lower(): value for key, value in self.headers.items()}
                stub.requests.append({"method": self.command, "path": parts.path, "query": query, "headers": headers})
                if stub.failing:
                    status, payload = stub.failing, {"error": "stub failure"}
                else:
                    status, payload = route(stub, self.command, parts.path, query, headers, body)
                data = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = _serve  # noqa: N815 - the name http.server looks for
            do_POST = _serve  # noqa: N815 - the name http.server looks for

            def log_message(self, *args):
                return None

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:" + str(self._server.server_address[1])
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self._thread.start()

    def close(self) -> None:
        """Stops the server."""
        self._server.shutdown()
        self._server.server_close()

    def revoke_tokens(self) -> None:
        """Invalidates every access token issued so far."""
        self.tokens.clear()


def doppler(token: str, secrets: dict[str, str]) -> Stub:
    """A Doppler config behind a service token.

    Args:
        token: The service token it accepts.
        secrets: What it serves.

    Returns:
        The running stub.
    """

    def route(stub, method, path, query, headers, body):
        if headers.get("authorization") != "Bearer " + token:
            return 401, {"success": False}
        if method == "GET" and path == "/v3/configs/config/secrets/download" and query.get("format") == "json":
            return 200, stub.secrets
        return 404, {"success": False}

    stub = Stub(route)
    stub.secrets = dict(secrets)
    return stub


def infisical(
    client_id: str,
    client_secret: str,
    project_id: str,
    environment: str,
    secrets: dict[str, str],
    expires_in: int = 3600,
) -> Stub:
    """An Infisical project environment behind a machine identity.

    Args:
        client_id: The client id it accepts.
        client_secret: The client secret it accepts.
        project_id: The project the secrets belong to.
        environment: The environment slug.
        secrets: What it serves.
        expires_in: The lifetime in seconds it gives access tokens.

    Returns:
        The running stub.
    """

    def route(stub, method, path, query, headers, body):
        if method == "POST" and path == "/api/v1/auth/universal-auth/login":
            if not body or body.get("clientId") != client_id or body.get("clientSecret") != client_secret:
                return 401, {"message": "Invalid credentials"}
            token = "infisical-access-" + str(uuid.uuid4())
            stub.tokens.add(token)
            stub.logins += 1
            return 200, {"accessToken": token, "expiresIn": expires_in, "tokenType": "Bearer"}
        if method == "GET" and path == "/api/v3/secrets/raw":
            presented = (headers.get("authorization") or "").removeprefix("Bearer ")
            if presented not in stub.tokens:
                return 401, {"message": "Token is not valid"}
            if (
                query.get("workspaceId") != project_id
                or query.get("environment") != environment
                or query.get("secretPath") != "/"
            ):
                return 404, {"message": "not found"}
            return 200, {"secrets": [{"secretKey": k, "secretValue": v} for k, v in stub.secrets.items()]}
        return 404, {"message": "not found"}

    stub = Stub(route)
    stub.secrets = dict(secrets)
    return stub


def vault(
    path: str,
    secrets: dict[str, str],
    token: str | None = None,
    role_id: str | None = None,
    secret_id: str | None = None,
    namespace: str | None = None,
) -> Stub:
    """A Vault KV v2 secret reachable with a token or AppRole.

    Args:
        path: The secret's path under the ``secret`` mount.
        secrets: What it serves.
        token: A static token it accepts, if any.
        role_id: The AppRole role id it accepts, if any.
        secret_id: The AppRole secret id it accepts, if any.
        namespace: A namespace header it requires, if any.

    Returns:
        The running stub.
    """

    def route(stub, method, request_path, query, headers, body):
        if namespace and headers.get("x-vault-namespace") != namespace:
            return 403, {"errors": ["namespace not found"]}
        if method == "POST" and request_path == "/v1/auth/approle/login":
            if not body or body.get("role_id") != role_id or body.get("secret_id") != secret_id:
                return 400, {"errors": ["invalid role or secret ID"]}
            client_token = "vault-client-" + str(uuid.uuid4())
            stub.tokens.add(client_token)
            stub.logins += 1
            return 200, {"auth": {"client_token": client_token, "lease_duration": 3600}}
        if method == "GET" and request_path.startswith("/v1/secret/data/"):
            presented = headers.get("x-vault-token")
            if presented != token and presented not in stub.tokens:
                return 403, {"errors": ["permission denied"]}
            if request_path == "/v1/secret/data/" + path:
                return 200, {"data": {"data": stub.secrets, "metadata": {"version": 1}}}
            return 404, {"errors": []}
        return 404, {"errors": ["unsupported path"]}

    stub = Stub(route)
    stub.secrets = dict(secrets)
    return stub


def _signed_with(headers: dict, access_key_id: str) -> bool:
    """Whether a SigV4 ``Authorization`` header names this access key, which is all a stand-in checks."""
    return ("Credential=" + access_key_id + "/") in headers.get("authorization", "")


_AWS_REJECTED = (400, {"__type": "UnrecognizedClientException", "message": "The security token included is invalid."})
_AWS_UNSUPPORTED = (400, {"__type": "UnknownOperationException", "message": "unsupported"})


def aws_secrets_manager(access_key_id: str, secret_id: str, secrets: dict[str, str]) -> Stub:
    """AWS Secrets Manager, one JSON secret, reachable with one access key (the JSON 1.1 protocol boto3 speaks).

    Args:
        access_key_id: The key id it accepts.
        secret_id: The secret it holds.
        secrets: What the secret contains.

    Returns:
        The running stub; change ``.secrets`` to rotate a value.
    """

    def route(stub, method, path, query, headers, body):
        if not _signed_with(headers, access_key_id):
            return _AWS_REJECTED
        if method == "POST" and headers.get("x-amz-target") == "secretsmanager.GetSecretValue":
            if not body or body.get("SecretId") != secret_id:
                return 400, {"__type": "ResourceNotFoundException", "message": "Secrets Manager can't find it."}
            return 200, {"Name": secret_id, "VersionId": str(uuid.uuid4()), "SecretString": json.dumps(stub.secrets)}
        return _AWS_UNSUPPORTED

    stub = Stub(route)
    stub.secrets = dict(secrets)
    return stub


def aws_ssm(access_key_id: str, path: str, secrets: dict[str, str], page_size: int = 2) -> Stub:
    """AWS Parameter Store, a path of parameters, paged ``page_size`` at a time.

    Args:
        access_key_id: The key id it accepts.
        path: The path the parameters live under.
        secrets: What the parameters hold. One parameter a level deeper is served too, so a provider must ignore it.
        page_size: How many parameters one page returns.

    Returns:
        The running stub; change ``.secrets`` to rotate a value.
    """

    def route(stub, method, request_path, query, headers, body):
        if not _signed_with(headers, access_key_id):
            return _AWS_REJECTED
        if method == "POST" and headers.get("x-amz-target") == "AmazonSSM.GetParametersByPath":
            if not body or body.get("Path") != path or body.get("WithDecryption") is not True:
                return 200, {"Parameters": []}
            every = [
                {"Name": path + "/" + name, "Type": "SecureString", "Value": value, "Version": 1}
                for name, value in stub.secrets.items()
            ]
            every.append(
                {
                    "Name": path + "/nested/DEEPER_SECRET",
                    "Type": "SecureString",
                    "Value": "deeper-" + str(uuid.uuid4()),
                    "Version": 1,
                }
            )
            start = int(body["NextToken"]) if body.get("NextToken") else 0
            payload: dict = {"Parameters": every[start : start + page_size]}
            if start + page_size < len(every):
                payload["NextToken"] = str(start + page_size)
            return 200, payload
        return _AWS_UNSUPPORTED

    stub = Stub(route)
    stub.secrets = dict(secrets)
    return stub
