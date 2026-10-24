# Secrets providers

A secrets provider decides where the server reads its secrets from. The
secrets are `DROPCOWBOY_API_KEY`, `DROPCOWBOY_API_SECRET`,
`DROPCOWBOY_WEBHOOK_SECRET` and `DC_PASSCODE`, plus any variable a provider you
chose lists in its `configKeys`.

Set `DC_SECRETS`.

| Value | Reads from | Settings |
|---|---|---|
| `env` (default) | The process environment and `.env`. Loads nothing extra. | none |
| `file` | One file per secret, named like the variable (`DROPCOWBOY_API_KEY`), content is the value. This is how Docker and Compose secrets (`/run/secrets`) arrive. | `DC_SECRETS_DIR` (required), `DC_SECRETS_REFRESH_SECONDS` |
| `doppler` | Doppler, through its REST API. | `DOPPLER_TOKEN` (required), `DOPPLER_API_URL` |
| `infisical` | Infisical, with a machine identity (universal auth). | `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_PROJECT_ID` (required); `INFISICAL_ENVIRONMENT` (default `prod`), `INFISICAL_SECRET_PATH` (default `/`), `INFISICAL_URL` |
| `vault` | HashiCorp Vault or OpenBao, KV version 2. | `VAULT_ADDR`, `VAULT_PATH`, and either `VAULT_TOKEN` or `VAULT_ROLE_ID` with `VAULT_SECRET_ID` (required); `VAULT_MOUNT` (default `secret`), `VAULT_APPROLE_MOUNT` (default `approle`), `VAULT_NAMESPACE` |
| `1password` | 1Password, with a service account. | `OP_SERVICE_ACCOUNT_TOKEN`, `OP_VAULT` (required), `OP_ITEM` |
| `aws-secrets-manager` | AWS Secrets Manager: one secret holding a JSON object. | `DC_AWS_SECRET_ID` (required), `AWS_REGION` |
| `aws-ssm` | AWS Systems Manager Parameter Store: one `SecureString` per secret under a path. | `DC_AWS_SSM_PATH` (required), `AWS_REGION` |
| `./path` | Your vault or secret manager. | Whatever you declare |

## Secret managers

`doppler`, `infisical`, `vault` and `1password` read the same four names and
follow the loading rules below. The one thing they cannot read from the manager
is the credential that signs in to it: that **bootstrap credential**
(`DOPPLER_TOKEN`, `INFISICAL_CLIENT_SECRET`, `VAULT_TOKEN` or
`VAULT_SECRET_ID`, `OP_SERVICE_ACCOUNT_TOKEN`) comes from the host's own
environment or a platform secret. It is redacted from every log line like any
other secret. Use a credential that can read only this app's secrets and
nothing else.

All four managers share these rules:

- The address must be `https`. Plain `http` is accepted only for a loopback
  address (`localhost`, `127.0.0.1`, `::1`), for local development. Anything else
  fails with `invalid_secrets_url`, so a credential is never sent in clear text.
- A redirect is refused, so a credential is never forwarded to another host.
- A request times out after 10 seconds.
- An error names the manager and the HTTP status. It never includes a response
  body, a query string, a header or a credential.
- A manager that cannot be read at boot is `secret_load_failed`. A manager that
  fails later keeps the last good values and logs a warning.

### Doppler

Create a service token for the config, set `DOPPLER_TOKEN` to it, and store
`DROPCOWBOY_API_KEY`, `DROPCOWBOY_API_SECRET` and `DROPCOWBOY_WEBHOOK_SECRET`
in the config. The provider downloads the whole config and keeps the names it
needs.

### AWS Secrets Manager and Parameter Store

These two have no bootstrap credential: the AWS SDK finds one itself, which on
ECS is the task role. Give that role read access to this app's secret or path
and nothing else (`secretsmanager:GetSecretValue` on one secret, or
`ssm:GetParametersByPath` on one path, plus `kms:Decrypt` on your own key).

- `aws-secrets-manager`: set `DC_AWS_SECRET_ID` to the secret's name or ARN. The
  secret is a JSON object with a field per starter secret, for example
  `{"DROPCOWBOY_API_KEY": "...", "DROPCOWBOY_API_SECRET": "..."}`. Fields that
  are not strings, and names the starter does not ask for, are ignored. A
  rotation is picked up within `DC_SECRETS_REFRESH_SECONDS`.
- `aws-ssm`: set `DC_AWS_SSM_PATH` to a path such as `/starter-crm`, and create
  each secret as a `SecureString` named `/starter-crm/DROPCOWBOY_API_KEY`. The
  provider reads the path with decryption, one level deep.
- `AWS_ENDPOINT_URL` points either at a local stand-in; in production it must be
  `https`.

The `ecs-express.yaml` template can do either for you: `--secrets-mode inject`
(default) hands the values to the container as secrets, `--secrets-mode runtime`
makes the app read Secrets Manager itself, so a rotation needs no redeploy.

### Infisical

Create a machine identity with universal auth, give it read access to the
project and environment, and set `INFISICAL_CLIENT_ID`,
`INFISICAL_CLIENT_SECRET` and `INFISICAL_PROJECT_ID`. The provider signs in
for a short-lived access token, signs in again before it expires, and once more
if the token is revoked early. Self-hosted Infisical sets `INFISICAL_URL`.

### Vault and OpenBao

Both speak the same API. Store the secrets as keys of one KV v2 secret at
`VAULT_PATH` under `VAULT_MOUNT`. Sign in with a token (`VAULT_TOKEN`) or with
an AppRole (`VAULT_ROLE_ID` and `VAULT_SECRET_ID`); setting both is
`invalid_vault_auth`. With an AppRole the provider logs in again at 80% of the
token's lifetime, and once more if the token is revoked early. A static token is
not retried, since a new one cannot be had. `VAULT_NAMESPACE` is for Vault
Enterprise and HCP Vault. A missing secret names the mount and path, which is
usually a typo.

### 1Password

Create a service account that can read one vault, and set
`OP_SERVICE_ACCOUNT_TOKEN` and `OP_VAULT`. Then pick one of two layouts:

- **One item** (`OP_ITEM` set): the item has a field per secret, named like the
  variable. The provider reads `op://<vault>/<item>/<NAME>`.
- **One item per secret** (`OP_ITEM` empty): each secret is an item named like the
  variable, with its value in the `credential` field. The provider reads
  `op://<vault>/<NAME>/credential`.

A name with no matching field is left out. If no name can be read at all, boot
fails, since that means a wrong vault, item or token. The SDK
(`@1password/sdk` or `onepassword-sdk`) loads only when this provider is chosen.

The Node and Python images include both SDKs so any of the four works without a
rebuild.

## How loading works

1. Before the configuration is parsed, boot asks the provider to `load` every
   secret name the starter reads. What it returns replaces the same variable from
   the environment, so "required variable" checks see it.
2. Loaded values join the **redaction list**: they never appear in a log line,
   an error or a boot problem.
3. Refreshing is lazy and needs no timer. A request that arrives after
   `DC_SECRETS_REFRESH_SECONDS` (default 300, `0` turns it off) calls the
   provider's `refresh()` first. The API key, API secret and webhook secrets in
   use are swapped without a restart, so you can rotate them. A refresh that
   fails keeps the last good values and logs a warning that names no value.
4. `DC_PASSCODE` is read once, at boot. Rotating it means a restart, which also
   signs everyone out.

The `file` provider logs a warning naming the file if it is world-readable.
Use `chmod 600`.

## The interface

| Export | Node | Python |
|---|---|---|
| Name | `name` | `name` |
| Variables it reads | `configKeys` | `config_keys` |
| Check the settings | `validate(env)` | `validate(env)` |
| Build the instance | `create(ctx)` | `create(ctx)` |

The instance has:

- `load(names)` returns `{ NAME: value }` for the names it has. Return only
  names you know. An absent name is simply left out.
- Optional `refresh()` returns the same shape from a fresh read.

Both may be async in Node. In Python they are plain calls.

## Write your own

Node, `my-secrets.js`, reading from a secret manager through its client:

```js
export const name = 'my-secrets';
export const configKeys = ['MY_VAULT_URL'];

export function validate(env) {
    return env.MY_VAULT_URL
        ? []
        : [{ code: 'missing_vault_url', message: 'MY_VAULT_URL is not set.', fix: 'Set MY_VAULT_URL.', docs: '' }];
}

export function create(ctx) {
    async function read(names) {
        const out = {};
        for (const key of names) {
            // Replace with your vault client. Return only what it has.
            const value = await fetchFromVault(ctx.env.MY_VAULT_URL, key);
            if (value) out[key] = value;
        }
        return out;
    }
    return { load: read, refresh: () => read(['DROPCOWBOY_API_KEY', 'DROPCOWBOY_API_SECRET', 'DROPCOWBOY_WEBHOOK_SECRET']) };
}
```

`MY_VAULT_URL` must itself come from the environment, since it is needed
before anything can be loaded. Keep it to non-secret settings or a short
credential from your platform.

Export `testVectors` (`test_vectors` in Python), a list of
`{ names, expect }`, to have the check call `load(names)` and compare values.

## Check it

```sh
npm run conformance:provider -- secrets ./my-secrets.js MY_VAULT_URL=https://vault.example.com
python -m starter_crm.provider_check secrets ./my_secrets.py MY_VAULT_URL=https://vault.example.com
```
