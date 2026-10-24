# Starter CRM server contract

This file is the source of truth for the Starter CRM server. Every
implementation (`node/`, `python/`, or your own port) must behave exactly as
described here, and must pass the suite in [`conformance/`](conformance/).
The front-ends only ever talk to these routes, so they work unchanged on any
server that passes.

Keywords: **must** is required and tested; **should** is recommended.

## Why the starter has a server at all

1. **Minting site tokens.** A site token is minted with your Drop Cowboy API
   key. The key must never reach a browser, so in `server` mode your backend
   mints a short-lived token for the signed-in user and hands the browser only
   the token. In `login` mode the browser signs in with Drop Cowboy instead,
   but it still asks this server to mint: the mint endpoint is first-party
   only, and Drop Cowboy does not let a page on your origin read its response.
   The browser only ever talks to the routes in this contract.
2. **Receiving webhooks.** Drop Cowboy tells you about inbound texts and call
   outcomes by POSTing signed webhooks. Something you run has to verify them
   and keep your own records in sync.

## Configuration

Read from environment variables. Implementations must load
`<starter root>/.env` (the folder holding `.env.example`). Variables already set
in the process environment win over the file.

| Variable | Default | Notes |
|---|---|---|
| `DC_AUTH_MODE` | `server` | `server`, `mcp-session` or `login`. Anything else fails at boot. |
| `DC_ENV` | `development`, `production` on Vercel and Netlify | `development` or `production`. Deploy templates set `production`. |
| `DC_IDENTITY` | `dev` | Who your app's user is in `server` mode: `dev` (a fixed placeholder user, refused in production), `passcode`, `oidc`, or a relative path to your own [identity provider](#providers). Only valid in `server` mode: any other value with `login` or `mcp-session` fails at boot. |
| `DC_PASSCODE` | none | `passcode` identity: the shared passcode, at least 12 characters. Secret. |
| `DC_OIDC_ISSUER` | none | `oidc` identity: the issuer URL, `https` (plain `http` only for a loopback host, so tests can run a local issuer). Must equal the token's `iss`. |
| `DC_OIDC_AUDIENCE` | none | `oidc` identity: the audience the token must carry in `aud`. |
| `DC_OIDC_JWKS_URL` | discovered | `oidc` identity: the key set URL. When empty it is read from `<issuer>/.well-known/openid-configuration`. |
| `DC_SECRETS` | `env` | Where secrets come from: `env`, `file`, `doppler`, `infisical`, `vault`, `1password`, `aws-secrets-manager`, `aws-ssm`, or a relative path to your own secrets provider. |
| `DC_SECRETS_DIR` | none | `file` secrets: the folder holding one file per secret, named exactly like the variable. Required with `DC_SECRETS=file`. |
| `DC_SECRETS_REFRESH_SECONDS` | `300` | How often a secrets provider that can refresh is asked to re-read (0 turns refreshing off). |
| `DC_RATE_LIMIT` | `redis` when `DC_REDIS_URL` is set, else `memory` | `memory`, `redis`, `off`, or a relative path to your own rate-limit provider. |
| `DC_STORE` | `memory`, `postgres` on Vercel and Netlify when `DC_DATABASE_URL`, `DATABASE_URL` or `NETLIFY_DB_URL` is set | The [event store](#event-store): `memory`, `sqlite`, `postgres`, `redis`, `dynamodb`, or a relative path to your own. |
| `DC_DATA` | follows `DC_STORE` | Where [modules](#modules) keep their data: `memory`, `sqlite`, `postgres`, `dynamodb`, or a relative path to your own. Empty follows the store when that is `memory`, `sqlite`, `postgres` or `dynamodb`; `DC_STORE=redis` or your own store needs it set in `server` mode. |
| `DC_SQLITE_PATH` | `data/starter-crm.sqlite` | `sqlite` store: the database file, relative to the starter root. |
| `DC_DATABASE_URL` | none | `postgres` store: the connection URL. `DATABASE_URL` is read when this is empty, then `NETLIFY_DB_URL`, which Netlify Database sets. Secret. |
| `DC_REDIS_URL` | none | `redis` store, fan-out, rate limit and BullMQ: the connection URL. Secret. |
| `DC_REDIS_CLUSTER` | `off` | `on`, `1` or `true` treats `DC_REDIS_URL` as one node of a Redis Cluster (ElastiCache cluster mode, for example) and connects with a cluster client. `off`, `0`, `false` or empty means one server. The Python server cannot run `bullmq` on a cluster. |
| `AWS_REGION` | none | The `dynamodb` store and data provider, the `sqs` mode and the `aws-*` secrets providers: the region. `AWS_DEFAULT_REGION` is read when it is empty. ECS sets it. |
| `AWS_ENDPOINT_URL` | none | AWS providers: send requests to a stand-in such as dynamodb-local or ElasticMQ instead of AWS. A service-specific `AWS_ENDPOINT_URL_DYNAMODB`, `_SQS`, `_SECRETS_MANAGER` or `_SSM` wins. `https` in production, unless the host is local. |
| `DC_DYNAMODB_TABLE` | `starter-crm` | `dynamodb` store and data: the table. The CloudFormation template creates it and sets this. |
| `DC_DYNAMODB_AUTO_CREATE` | `off` | `on`, `1` or `true` lets the server create the table when it is missing. For a local stand-in: the task role of a real deployment should not be able to create tables. |
| `DC_SQS_QUEUE_URL` | none | `sqs` mode: the queue's URL. One queue per site. |
| `DC_AWS_SECRET_ID` | none | `aws-secrets-manager`: the name or ARN of one secret holding a JSON object with a field per starter secret. |
| `DC_AWS_SSM_PATH` | none | `aws-ssm`: the Parameter Store path, such as `/starter-crm`; each secret is a `SecureString` named `<path>/<NAME>`. |
| `DC_INSECURE_PRIVATE_SERVICES` | `off` | `on`, `1` or `true` lifts the production TLS requirement for Redis and Postgres on a private network you control. |
| `DC_FANOUT` | by store | How a finished event reaches every instance: `local`, `poll`, `redis`, `postgres`, or a relative path. See [Fan-out](#fan-out). |
| `DC_FANOUT_POLL_MS` | `1000` | `poll` fan-out interval, 100–60000. |
| `DC_WEBHOOKS` | by store | How handlers run: `store`, `bullmq`, `sqs`, `vercel-queue`, `netlify-async`, `qstash`, `inline`, or a relative path. On Vercel, `vercel-queue`; on Netlify, `netlify-async`. Elsewhere `bullmq` when the store is durable and `DC_REDIS_URL` is set, else `sqs` when the store is `dynamodb` and `DC_SQS_QUEUE_URL` is set, else `store`. |
| `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | none | `qstash` mode: the token that publishes, and the two signing keys that verify QStash's calls back (the next key lets a rotation finish without dropping messages). Secret. |
| `AWL_API_KEY` | none | `netlify-async` mode: the key the Async Workloads router asks for. The extension sets it on a paid team; on a Starter team you create it for the site. `AWL_API_KEY_P<n>` keys being rotated are read too, the highest `n` first. Secret. |
| `QSTASH_URL` | `https://qstash.upstash.io` | `qstash` mode: the QStash address, for a regional account or a local development server. |
| `CRON_SECRET` | none | The Next.js variant on Vercel: the secret Vercel Cron sends as `Authorization: Bearer` to `/internal/maintenance`. Without it the route answers 503. Secret. |
| `DC_WEBHOOK_HANDLERS` | none | A relative path to a file exporting `handlers`. Empty means no handlers. |
| `DC_WEBHOOK_MAX_ATTEMPTS` | `8` | Runs of a failing handler before the event is `failed`, 1–50. |
| `DC_WEBHOOK_HANDLER_BUDGET_MS` | `3000` | `inline` mode: how long handlers get before their `signal` fires, 100–4500. |
| `DC_OUTBOX_POLL_MS` | `1000` | How often a worker looks for due events, 100–60000. |
| `DC_WORKER_IN_PROCESS` | `on` | `on` runs the worker in the web process; `off` leaves it to the separate worker command. |
| `DC_EVENT_RETENTION_HOURS` | `72` | Finished events are deleted this long after they finish, 1–8760. |
| `DC_EVENTS_MAX_STREAM_SECONDS` | `0`, `290` on Vercel, `25` on Netlify | Close each `/api/events` stream after this many seconds so clients reconnect. `0` means never, at most 86400. A function has a time limit, so Vercel's default sits just under the 300 seconds of a function that is not on a longer plan, and Netlify's under the 30 seconds measured on its streaming functions. |
| `DC_TOKEN_CACHE` | `on` | `on` or `off`. Caches each user's minted site token in `server` mode. |
| `DC_LOG_FORMAT` | `pretty`, `json` in production | `pretty` or `json`. |
| `DC_LOG_REQUESTS` | `on` in production, else `off` | `on` or `off`. Writes one access-log line per request. |
| `DC_LOG` | `console` | The log sink: `console`, or a relative path to your own log provider. |
| `DC_OBSERVER` | none | A relative path to your own [observer](#observer-hooks). Empty means none. |
| `DC_CSP` | `report-only` | `report-only`, `enforce` or `off`. |
| `DC_CORS_ORIGINS` | none | Comma-separated origins allowed to call the API from another site. CORS is off when empty. `*` is not accepted. |
| `DC_PUBLIC_URL` | none | Public origin (no path) browsers and Drop Cowboy use to reach this server, for example `https://crm.example.com`. When set, boot logs the webhook URL. `qstash` mode needs it (on Vercel it falls back to the project's production domain), because QStash calls that address back. |
| `DC_TRUST_PROXY` | `0` | Hop count for `X-Forwarded-*` behind a reverse proxy. `0` means do not trust those headers. |
| `DC_SHUTDOWN_GRACE_SECONDS` | `10` | How long SIGTERM waits for open SSE streams and in-flight requests before the process exits (1–300). |
| `DROPCOWBOY_API_KEY` | none | Required in `server` mode, unused in the others. Secret. |
| `DROPCOWBOY_API_SECRET` | none | Required in `server` mode, unused in the others. Secret. |
| `DROPCOWBOY_SITE_ID` | none | Required in `server` and `login` modes, the two that mint. Whenever it is set, in any mode, it must be a UUID (any version); Drop Cowboy rejects any other `site_id` with `400 invalid_site_id`. One stable value per deployed app. |
| `DROPCOWBOY_WEBHOOK_SECRET` | none | Signing secret, or a comma-separated list of them. Drop Cowboy issues one secret per webhook (an account can hold many, each carrying any set of event types), and a new one only when you rotate it. Without it, webhooks are refused with `503`. Secret. |
| `DROPCOWBOY_API_BASE` | `https://api-v2.dropcowboy.com` | No trailing slash. Must be `http(s)`. |
| `AUTH0_DOMAIN` | `login.dropcowboy.com` | Used by `login` mode in the browser. |
| `AUTH0_CLIENT_ID` | empty | Public SPA client id. Not a secret. |
| `AUTH0_AUDIENCE` | `https://api-v2.dropcowboy.com` | |
| `DC_CDN_VERSION` | empty | Pins the widget CDN version the browser loads. Empty means the front-end's own default. |
| `STARTER_CRM_USER_ID` | none | Required with the `dev` identity (the default) in `server` mode, and must be a UUID. Stands in for your signed-in user in the `dev` identity. Optional with `passcode`, where it names the one passcode user. |
| `HOST` | `127.0.0.1` | Loopback by default. |
| `PORT` | `8080` | |

Two optional variables exist so tests can run without touching your files:

| Variable | Default | Notes |
|---|---|---|
| `STARTER_CRM_ROOT` | the starter folder | Where `.env`, `.dropcowboy/session.json`, `shared/`, `vanilla/` and `react/dist/` are looked up. Read from the real environment only, never from `.env`. |
| `DROPCOWBOY_TIMEOUT_MS` | `10000` | Timeout for every call to Drop Cowboy. |

### Boot

Boot failures are **structured problems**. Each problem is:

```json
{ "code": "missing_api_key", "message": "…", "fix": "…", "docs": "TROUBLESHOOTING.md#missing_api_key" }
```

The process prints them to stderr (code, message, fix, docs) and exits
non-zero. No secret value may appear in any field.

- In `server` mode, a missing or invalid `DROPCOWBOY_API_KEY`,
  `DROPCOWBOY_API_SECRET`, `DROPCOWBOY_SITE_ID` or `STARTER_CRM_USER_ID` must stop the
  process and name every missing variable in `message`.
- In `login` mode, a missing `DROPCOWBOY_SITE_ID` must stop the process the
  same way. Nothing else is required: the API key, secret and
  `STARTER_CRM_USER_ID` are not used, and the message must not ask for them.
- A `DROPCOWBOY_SITE_ID` that is set but is not a UUID must stop the process the
  same way in every mode, with a message that names the variable and says it
  must be a UUID.
- An unknown `DC_AUTH_MODE` must stop the process the same way.
- If `SAMPLE_USER_ID` or `SAMPLE_CRM_ROOT` is set, boot fails with code
  `renamed_env` and a message that names the `STARTER_CRM_*` replacement.
  There are no `SAMPLE_*` aliases.
- `DC_IDENTITY` must be `dev`, `passcode`, `oidc` or a path starting `./` or
  `../`, else `invalid_identity`. Outside `server` mode anything but `dev` is
  `identity_requires_server_mode`. `passcode` needs `DC_PASSCODE`
  (`missing_passcode`) of at least 12 characters (`weak_passcode`). `oidc`
  needs `DC_OIDC_ISSUER` (`missing_oidc_issuer`, `invalid_oidc_issuer`) and
  `DC_OIDC_AUDIENCE` (`missing_oidc_audience`), and a set `DC_OIDC_JWKS_URL`
  must be `http(s)` (`invalid_oidc_jwks_url`).
- `DC_LOG_FORMAT`, `DC_CSP`, `DC_RATE_LIMIT`, `DC_TOKEN_CACHE`, `DC_LOG_REQUESTS`,
  `DC_SECRETS` and `DC_CORS_ORIGINS` outside their allowed values fail with
  `invalid_log_format`, `invalid_csp`, `invalid_rate_limit`,
  `invalid_token_cache`, `invalid_log_requests`, `invalid_secrets_provider`
  and `invalid_cors_origins`. `DC_SECRETS=file` without a readable
  `DC_SECRETS_DIR` is `missing_secrets_dir`. A custom provider file that
  cannot be loaded, or does not have the [provider shape](#providers), is
  `invalid_provider`. A provider's own `validate()` problems are reported
  with the provider's codes. A secrets provider that throws is
  `secret_load_failed`.
- The built-in secrets providers are `env`, `file`, `doppler`, `infisical`,
  `vault`, `1password`, `aws-secrets-manager` and `aws-ssm`. A manager address must be `https` unless it is a
  loopback host (`invalid_secrets_url`), a redirect is never followed, and an
  error names the manager and the status, never a body or a credential. The
  codes are `missing_doppler_token`, `missing_infisical_setting`,
  `missing_vault_setting`, `invalid_vault_auth`, `invalid_vault_path`,
  `missing_onepassword_setting`, `invalid_onepassword_setting`,
  `missing_aws_secret_id`, `missing_aws_ssm_path` and `invalid_aws_ssm_path`.
  The credential that signs in to a manager is redacted like any secret. The
  AWS providers hold no credential of their own: the AWS SDK finds one (the
  ECS task role), and an error names the service and the HTTP status.
- The event settings fail with `invalid_store`, `invalid_fanout`,
  `invalid_webhooks_mode`, `invalid_webhook_handlers`, `invalid_worker_in_process`,
  `invalid_event_retention`, `invalid_max_stream_seconds`, `invalid_fanout_poll`,
  `invalid_outbox_poll`, `invalid_webhook_attempts` and `invalid_handler_budget`.
  Combinations that cannot work fail too: a fan-out or `bullmq` with
  `DC_STORE=memory` is `store_not_shared`, `DC_FANOUT=postgres` without the Postgres
  store is `fanout_needs_postgres`, `DC_WORKER_IN_PROCESS=off` with a store only
  this process can read is `worker_needs_shared_store`, and with `local` fan-out is
  `worker_needs_fanout`.
- A store, fan-out, rate limit or queue that needs a URL fails with
  `missing_redis_url` / `missing_database_url` when it is empty, and
  `invalid_redis_url` / `invalid_database_url` when it is not a Redis or
  Postgres URL. With `DC_ENV=production`, a host that is not local must use TLS
  (`rediss://`, and `sslmode=require` or stronger on Postgres) or boot fails with
  `insecure_redis_url` / `insecure_database_url`, unless
  `DC_INSECURE_PRIVATE_SERVICES` is `on`, `1` or `true`. No URL's password may
  appear in any field.
- Anything that talks to AWS (`DC_STORE=dynamodb`, `DC_DATA=dynamodb`,
  `DC_WEBHOOKS=sqs`, the `aws-*` secrets providers) needs a region:
  `missing_aws_region`. `AWS_ENDPOINT_URL` that is not a URL is
  `invalid_aws_endpoint`; with `DC_ENV=production` a plain-`http` endpoint on a
  host that is not local is `insecure_aws_endpoint`. A table name that DynamoDB
  would refuse is `invalid_dynamodb_table`. `DC_WEBHOOKS=sqs` without a queue is
  `missing_sqs_queue_url`, a queue that is not a URL is `invalid_sqs_queue_url`,
  and a plain-`http` queue in production is `insecure_sqs_queue_url`.
- `DC_REDIS_CLUSTER` outside its values is `invalid_redis_cluster`. The Python
  server with `DC_WEBHOOKS=bullmq` and a cluster is `bullmq_cluster_unsupported`:
  set `DC_WEBHOOKS=store` (or `sqs` on AWS), or run the Node server.
- On a serverless host (Vercel, found from `VERCEL`; Netlify, from `NETLIFY`) a
  function instance lives for a request or a few minutes and is frozen in
  between, so settings that keep events in one instance, or need a process that
  stays up, are refused instead of losing events later: `DC_STORE=memory` or
  `sqlite` is `serverless_store`, `DC_WEBHOOKS=store` is
  `serverless_webhooks_store`, a polling mode (`bullmq`, `sqs`) with its worker in
  the web process is `serverless_worker`, and `DC_FANOUT=local` is
  `serverless_fanout`. The defaults there are `poll` fan-out (`redis` when
  `DC_REDIS_URL` is set), `vercel-queue` on Vercel and `netlify-async` on Netlify. A `postgres` fan-out
  asked for on such a host runs as `poll`, with a notice, because a pooled
  database URL does not deliver LISTEN/NOTIFY.
- `DC_WEBHOOKS=qstash` needs `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`,
  `QSTASH_NEXT_SIGNING_KEY` (`missing_qstash_setting`, one problem per variable)
  and a public address (`missing_qstash_public_url`; `invalid_qstash_public_url`
  when it is not a URL, `insecure_qstash_public_url` when it is plain `http` in
  production; `invalid_qstash_url` for a `QSTASH_URL` that is not a URL).
  `DC_WEBHOOKS=vercel-queue` off Vercel is `vercel_queue_off_vercel`; the Python
  server refuses the mode with `vercel_queue_node_only`.
- `DC_WEBHOOKS=netlify-async` off Netlify is `netlify_async_off_netlify`, and
  without `AWL_API_KEY` (or an `AWL_API_KEY_P<n>`) it is `missing_awl_api_key`.
  The Python server refuses the mode with `netlify_async_node_only`.
- A durable store (`sqlite`, `postgres`) applies its [migrations](#migrations)
  at boot before the server takes traffic. `dynamodb` has no migrations: the
  table is created by the CloudFormation template (or by `DC_DYNAMODB_AUTO_CREATE`
  on a local stand-in) and its layout is part of this contract (see
  [DynamoDB](#dynamodb)).
- The module settings fail with `invalid_data` (a `DC_DATA` that is not a built-in
  name or a relative path), `data_provider_required` (`server` mode with
  `DC_STORE=redis` or a store of your own, and no `DC_DATA`) and `invalid_module`
  (a module that is missing its `id` or routes, shares an id with another, or
  fails to set up). In the other modes modules are not registered and
  `DC_DATA` is unused.
- When `DC_ENV=production` and `DC_IDENTITY=dev`, boot fails with code
  `production_dev_identity` and a `fix` that explains how to proceed.
- When `DC_ENV=production` and `DC_AUTH_MODE=mcp-session`, boot fails with
  code `production_mcp_session`.
- Secrets (API key, API secret, webhook secret), site tokens and login-mode
  access tokens must never be written to stdout, stderr or any log, at boot or
  later.

### Shutdown

On `SIGTERM` or `SIGINT` the server must:

1. Stop accepting new connections.
2. Mark itself not ready (`GET /readyz` returns `503`).
3. Send each open SSE client `retry: 1000` and close the stream.
4. Finish in-flight requests, for up to `DC_SHUTDOWN_GRACE_SECONDS`.
5. Stop the worker after the event in hand, and close the store, fan-out and queue connections.
6. Exit with code 0.

The separate worker process (`DC_WORKER_IN_PROCESS=off`) does the same on
`SIGTERM`: it finishes the event in hand and exits 0 within the grace period.
A server must never hang on `SIGTERM`: the conformance harness fails a server
that is still alive after the grace period.

A conformance case opens an event stream, sends `SIGTERM`, and asserts the
process exits within the grace period.

## Error envelope

Every error response from every route, including unknown routes, is JSON:

```json
{ "error": { "code": "invalid_purpose", "message": "purpose must be one of: session, contacts, campaigns, phone", "request_id": "6f1d2c3b-4a59-4e8f-9d7c-0b1a2c3d4e5f" } }
```

- `code` is a stable machine string. `message` is plain language for a human.
- `request_id` is the [request id](#request-ids) of the request, so a user can
  quote it and you can find the log lines.
- Nothing else is in the body. Raw upstream bodies are never echoed back.

### Codes the server produces itself

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_json` | The request body is not valid JSON. |
| 400 | `invalid_request` | A [module](#modules) route got a body, query or path that does not fit its schema. The message names the first field that is wrong and ends with a full stop. |
| 400 | `invalid_purpose` | `purpose` is missing or not in the allowlist. |
| 401 | `login_required` | `login` mode: the token or readiness route was called without a well-formed `Authorization: Bearer <access token>`. The front-end should sign the user in. |
| 401 | `login_expired` | `login` mode: Drop Cowboy answered `401` to the user's access token. Their sign-in expired or was revoked; the front-end should sign in again and retry. |
| 401 | `unauthenticated` | `oidc` identity: no `Authorization: Bearer` token. `passcode` identity: no valid session cookie. The front-end should sign the user in. |
| 401 | `invalid_token` | `oidc` identity: the token is expired, tampered, has the wrong issuer or audience or algorithm, or its signing key is unknown. |
| 401 | `invalid_passcode` | `passcode` identity: the passcode is wrong. |
| 401 | `missing_signature` | A webhook arrived without `X-Signature` or `X-Timestamp`. |
| 401 | `stale_timestamp` | `X-Timestamp` is not epoch seconds, or is more than 300 s from now. |
| 401 | `invalid_signature` | The HMAC does not match, or `X-Signature-Version` is not `v1`. |
| 403 | `csrf_rejected` | A cookie-authenticated state-changing request came from an origin this server does not trust. |
| 403 | `cors_rejected` | A CORS preflight came from an origin not in `DC_CORS_ORIGINS`. |
| 403 | `loopback_only` | `/__dev/session` was called from a non-loopback peer or with a non-loopback `Host`. |
| 404 | `not_found` | No such route, including routes not registered in the current mode. |
| 404 | `session_not_found` | `.dropcowboy/session.json` does not exist. |
| 410 | `session_expired` | The session file's `expires_at` is in the past. |
| 413 | `payload_too_large` | A request body is over 1 MB. |
| 415 | `unsupported_media_type` | A state-changing request that must be JSON was not sent as `application/json`. This includes a module route that checks a body. |
| 429 | `rate_limited` | A [rate limit](#rate-limits) was hit. Carries `Retry-After`. |
| 500 | `session_invalid` | The session file is not valid JSON, or lacks a string `token` and an epoch-millisecond `expires_at`. |
| 500 | `internal_error` | Anything unexpected. |
| 502 | `upstream_auth_failed` | `server` mode: Drop Cowboy answered `401` to this server's API key. The server's credentials are wrong, not the browser's, so this is deliberately not passed through as `401`: signing in again would not help. |
| 502 | `upstream_error` | Drop Cowboy answered `5xx`, or a success that is not the documented shape. |
| 502 | `upstream_unreachable` | The request to Drop Cowboy failed (DNS, connection refused, TLS). |
| 503 | `identity_unavailable` | `oidc` identity: the issuer's configuration or key set could not be fetched. |
| 503 | `webhook_not_configured` | `DROPCOWBOY_WEBHOOK_SECRET` is not set. |
| 503 | `webhook_not_queued` | The event was verified but could not be stored or queued. Drop Cowboy retries it. |
| 503 | `handler_failed` | `inline` mode: a handler threw. Drop Cowboy retries it. |
| 503 | `event_store_unavailable` | `GET /api/webhooks/status` could not read the event store. |
| 504 | `upstream_timeout` | Drop Cowboy did not answer within `DROPCOWBOY_TIMEOUT_MS`. |

### Passing through Drop Cowboy errors

When Drop Cowboy answers a proxied call with a `4xx` other than `401`, the
server answers with **the same status** and **the upstream code, unchanged**,
so a front-end can map `payment-required`, `consent_required`,
`insufficient-scope`, `byoc_required` and so on the same way on any server.

Drop Cowboy errors come in two shapes:

```json
{ "type": "https://api-v2.dropcowboy.com/errors/payment-required", "title": "Payment Required", "status": 402, "detail": "Add funds to continue." }
```

```json
{ "message": "A valid consent_id is required for this embed send", "detail": { "code": "consent_required" } }
```

Derive `code` from the first of these that is a non-empty string:

1. `detail.code` (when `detail` is an object)
2. `details.code`
3. `code`
4. `error`
5. the last path segment of `type`
6. a default for the status: `400 bad-request`, `402 payment-required`,
   `403 forbidden`, `404 not-found`, `409 conflict`, `422 unprocessable-entity`,
   `429 too-many-requests`, any other `4xx` `bad-request`

Derive `message` from `detail` (when it is a string), then `message`, then
`title`, else a generic sentence. Cap it at 300 characters. For `429`, copy the
upstream `Retry-After` header when present.

`5xx` answers never pass through: they become `502 upstream_error` with a
generic message.

## Request ids

Every response carries `X-Request-Id`.

- A request's own `X-Request-Id` is kept when it matches
  `^[A-Za-z0-9._-]{1,64}$`. Anything else, or no header, gets a fresh UUID v4.
- The id is echoed on **every** response, errors and static files included, and
  appears in the `request_id` field of every error envelope, in every log
  line written while handling the request, and in every observer hook.

## Response headers

Set on every response, in every mode:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Permissions-Policy` | `microphone=(self), camera=(), geolocation=()`. The dialer needs the microphone. |
| `X-Frame-Options` | `DENY`. Needed because browsers ignore `frame-ancestors` in a report-only policy. |
| `Content-Security-Policy-Report-Only` or `Content-Security-Policy` | Per `DC_CSP`: `report-only` (the default) sends the first, `enforce` the second, `off` neither. The policy always contains `frame-ancestors 'none'` and `object-src 'none'`, and names only public origins: `'self'`, `https://webforms.dropcowboy.com` for the Building Blocks and `https://app-api-v2.dropcowboy.com`. |
| `Strict-Transport-Security` | `max-age=31536000`, only when `DC_ENV=production`. No `includeSubDomains`: the starter does not own your other subdomains. |

The policy stays report-only until Drop Cowboy publishes an official
Building Blocks origin list, so a missing origin cannot break the page.

## CORS

Off by default: everything is same-origin. `DC_CORS_ORIGINS` is an allowlist
of exact origins (`https://crm.example.com`, no path, no `*`) for a
front-end hosted elsewhere.

- With no allowlist, `OPTIONS` is `404 not_found` and no CORS header is ever
  sent.
- A request whose `Origin` is in the allowlist gets
  `Access-Control-Allow-Origin: <that origin>`, `Vary: Origin` and
  `Access-Control-Expose-Headers: X-Request-Id, Retry-After`. Credentials are
  never allowed cross-origin: a cross-origin front-end must send
  `Authorization`, not cookies.
- A preflight (`OPTIONS` with `Access-Control-Request-Method`) from an
  allowlisted origin is `204` with `Access-Control-Allow-Methods: GET, POST, OPTIONS`,
  `Access-Control-Allow-Headers: Authorization, Content-Type, Last-Event-ID, X-Request-Id`
  and `Access-Control-Max-Age: 600`. From any other origin it is
  `403 cors_rejected`.
- A non-preflight request from an origin not in the list is served normally
  but without CORS headers, so the browser blocks the response.

## Rate limits

Fixed one-minute windows, counted per instance with `DC_RATE_LIMIT=memory`,
or shared by every instance with `DC_RATE_LIMIT=redis` (the default when
`DC_REDIS_URL` is set). `DC_RATE_LIMIT=off` disables them. Over a limit the answer is
`429 rate_limited` with an integer `Retry-After` of at least `1`: the
seconds left in the window.

| What | Limit | Key |
|---|---|---|
| `POST /api/dropcowboy/token`, every request | 300 / min | client IP, counted before authentication |
| `POST /api/dropcowboy/token`, requests that reach Drop Cowboy | 30 / min | the user id (`server`), or a hash of the access token (`login`). A cache hit is not counted. |
| `POST /api/auth/passcode` | 10 / min | client IP |
| `GET /__dev/session` | 10 / min | client IP |
| Every [module](#modules) route (`/api/modules/...`) | 600 / min | the signed-in user's id |

Webhooks are never limited; the 1 MB body cap stays.

The client IP is the TCP peer, or with `DC_TRUST_PROXY=N` the entry N
positions from the right of `X-Forwarded-For` (the proxy chain you trust),
falling back to the peer.

## Providers

Each replaceable piece is a **provider**. The kinds are
`identity`, `secrets`, `ratelimit`, `log`, `observer`, `store`, `fanout`,
`webhooks` and `data`. Each is chosen by a
`DC_<KIND>` variable (`DC_IDENTITY`, `DC_SECRETS`, `DC_RATE_LIMIT`, `DC_LOG`,
`DC_OBSERVER`, `DC_STORE`, `DC_FANOUT`, `DC_WEBHOOKS`, `DC_DATA`) whose value is a built-in name or a relative path
(`./my-identity.js`, `./my_identity.py`) resolved against the starter root.

A provider module exports:

| Export | Meaning |
|---|---|
| `name` | A short name, used in logs. |
| `configKeys` | The environment variable names it reads (documentation, and the keys `secrets` providers are asked to load). |
| `validate(env)` | Returns an array of boot problems (`{ code, message, fix }`), empty when the configuration is usable. |
| `create(ctx)` | Returns the instance. May be async. `ctx` is `{ config, env, log, root }`. |

The instances:

| Kind | Instance |
|---|---|
| `identity` | `authenticate(request)` returns `{ id, email?, name? }` or `null`, and never throws for a bad credential. Optional `routes()` returns extra routes `{ method, path, handler }`. |
| `secrets` | `load(names)` returns `{ NAME: value }` for the names it has. Optional `refresh()` returns the same shape from a fresh read. Called before configuration is parsed. |
| `ratelimit` | `hit(key, limit, windowSeconds)` returns `{ allowed, remaining, retryAfterSeconds }`. |
| `log` | `write(record)` where `record` is `{ time, level, message, ... }`, already redacted. |
| `observer` | Any of the [hooks](#observer-hooks). |
| `store` | The [event store](#event-store) methods. |
| `fanout` | `publish(event)`, `subscribe(handler, { afterEventId })`, `ready()`, `close()`. See [Fan-out](#fan-out). |
| `webhooks` | `dispatch(eventId)`, `start()`, `stop()`, `ready()`, and optionally `sweep(eventIds)` and `visibleDelayMs`. See [Processing](#processing). |

Secrets work like this. Before configuration is parsed, boot asks the
provider to `load` every secret name the starter reads (`DROPCOWBOY_API_KEY`,
`DROPCOWBOY_API_SECRET`, `DROPCOWBOY_WEBHOOK_SECRET`, `DC_PASSCODE`) plus the
`configKeys` of the other chosen providers. What it returns replaces the same
variable from the environment and `.env`, so required-variable checks see it.
Refreshing is lazy, so no timer runs in the background (nothing is ever left
unawaited): a request that arrives after `DC_SECRETS_REFRESH_SECONDS` have
passed calls the provider's `refresh()` first, and the API key, API secret and
webhook secrets in use are swapped without a restart. A refresh that fails keeps the last good values and logs a warning
that names no value. `DC_PASSCODE` is read once at boot. `env` loads nothing
extra, and `file` reads `<DC_SECRETS_DIR>/<NAME>` (surrounding whitespace
trimmed) and logs a warning naming the file when it is readable by anyone
(world-readable). Loaded values are added to the redaction list.

In Node every provider method may be async and is awaited. In Python the
methods are plain synchronous calls: the WSGI server runs each request in
its own thread, so a blocking call stalls only that request. The names are
Python's own: `config_keys` for `configKeys`, `on_request`, `on_response`,
`on_error`, `on_webhook` and `on_token_minted` for the hooks, and
`retry_after_seconds` for `retryAfterSeconds`. A Python identity receives the
Flask request; a Node identity receives a web-standard `Request`. Both
expose `headers.get(name)`, case-insensitively.

`npm run conformance:provider -- <kind> <path>`
(Node) and `python -m starter_crm.provider_check <kind> <path>` (Python) check
a provider against its kind before you rely on it.

## Event store

Every verified webhook event is written to the event store before Drop Cowboy
gets its `200`. The store feeds the activity stream, retries and replay. The
built-ins are `memory`, `sqlite`, `postgres` and `redis`; the method list is in
`docs/providers/store.md` and is the same in Node and Python. The rules every
store keeps:

- `record` is atomic and idempotent on `event_id`: of two concurrent inserts of
  one id, one is new and the other is a duplicate.
- An event has a status: `received` (waiting for its handlers), `processed` or
  `failed`. Only a `received` event is run. A worker claims due events with a
  lease, so two workers never run one at the same time.
- `since({ afterEventId, limit })` returns finished events, oldest first, at
  most 200 (the newest 200 when more qualify). With a finished `afterEventId` it
  returns events that finished at or after that event's finish time minus 5
  seconds, excluding that event. An unknown or unfinished id is no cursor.
- Finished events are deleted `DC_EVENT_RETENTION_HOURS` after they finish.
  Events waiting for a handler are never deleted.
- `contact.deleted` erases a contact: once its handlers have run, the store
  deletes the contact's other events and strips the `contact.deleted` event down
  to `{ "contact_id": ... }`.
- Two sites (`DROPCOWBOY_SITE_ID`) sharing one database or Redis never read each
  other's events.
- Nothing about a connection (URL, password) is ever logged.

### Migrations

`sqlite` and `postgres` build their schema from the numbered SQL files in
`server/migrations/sqlite` and `server/migrations/postgres`, shared by the Node
and Python servers, and record each in `starter_crm_migrations`. They run at
boot: Postgres under transaction-scoped advisory lock `727001` (waits at most 60 s; a
session lock would leak through a pooled connection string) so instances
starting together never migrate at once, SQLite inside `BEGIN IMMEDIATE`. A file never changes after it
ships. `npm run migrate:status` exits `1` when one is pending. The module data
table (`starter_crm_data`) is migration `002_module_data`, applied by the same
lock and recorded in the same table; with `DC_STORE=redis` and `DC_DATA=sqlite`
or `postgres`, `migrate:status` reports the data database's migrations.

## Fan-out

A finished event is published to the fan-out, which hands it to every instance's
open streams. Only the event id travels; each instance reads the event from the
store. The built-ins are `local`, `poll`, `redis` and `postgres`.

- Every instance of a site hears about every finished event once the transport
  is up. Delivery may repeat; a stream sends each `event_id` at most once.
- The transport does not remember. A client that missed events catches up from
  the store through `Last-Event-ID`.
- The default is `local` for the `memory` store (and `sqlite` with the worker in
  the web process); otherwise `redis` when `DC_REDIS_URL` is set, else `postgres`
  for the Postgres store, else `poll` (so `dynamodb` without Redis polls).

## Processing

After a webhook is stored, a **mode** (`DC_WEBHOOKS`) decides how its handlers
run: `store` (a worker takes due events from the store), `vercel-queue`,
`netlify-async` and `qstash` (a hosted queue calls the server back, described below), `bullmq` (a worker takes
event ids from a Redis queue named `webhooks`, with the site id in its key
prefix and the event id as the job id, so a Node and a Python server can work one
queue), `sqs` (a worker takes messages from an Amazon SQS queue, described
below) or `inline` (in the request, before the `200`). Every mode ends in the same
processor:

1. Read the event. If it is not `received`, stop: it already finished.
2. Run the handlers from `DC_WEBHOOK_HANDLERS` for the event's name, and `*`.
3. On success, run the contact purge for `contact.deleted`, mark `processed`
   and publish to the fan-out.
4. On a thrown error, count the failure and schedule a retry after 1 s, doubling
   to 5 minutes. After `DC_WEBHOOK_MAX_ATTEMPTS` runs mark it `failed` and publish.

Handlers run **at least once**; they receive the event id so they can be
idempotent. A worker that dies mid-event leaves its lease to expire, and the next
worker runs the event again. `npm run webhooks:failed` lists failed events and
`npm run webhooks:replay -- <event_id>` puts one back to `received`.

### SQS mode

`DC_WEBHOOKS=sqs` sends one message per event to the queue `DC_SQS_QUEUE_URL`
before the webhook answers `200`. The body is `{"event_id": "<uuid>", "site_id": "<uuid>"}`
and nothing else: the worker reads the event from the store. A Node and a Python
server can work one queue. The queue belongs to one site; a message for another
site is left alone.

- SQS delivers **at least once** and does not order messages, so a message can
  arrive twice or out of order. The processor's first step (stop if the event is
  not `received`) makes that harmless.
- When a handler fails and another attempt is due, the message stays and its
  visibility timeout is set to the backoff, so SQS hands it out again on time.
  A message is deleted when the event is `processed`, `failed`, already
  finished, or gone.
- The queue's visibility timeout must be longer than the slowest handler. A
  message that keeps crashing the worker (not the same as a failing handler)
  goes to the dead-letter queue after the queue's `maxReceiveCount`. The event
  stays `received` in the store and the maintenance sweep queues it again.
- The Node worker long-polls for 20 seconds. The Python worker polls for 2
  seconds, because boto3 cannot abort a long poll and a stopping worker must
  not wait on one.

### Vercel Queues and QStash modes

`DC_WEBHOOKS=vercel-queue` and `DC_WEBHOOKS=qstash` are for hosts with no process
between requests. The webhook records the event in the store, then sends one
message to a hosted queue and answers `200` only after the queue has accepted it.
The message is `{"event_id": "<uuid>", "site_id": "<uuid>"}` and nothing else.
The queue then calls the server back on an [internal route](#internal-routes),
which reads the event from the store and runs the processor. There is no worker:
`start()` and `stop()` do nothing, and nothing runs after a response ends.

- Both queues deliver **at least once**, so the processor's first step (stop if
  the event is not `received`) matters here as in every mode.
- When a handler fails and another attempt is due, the callback fails so the
  queue retries after the same backoff as every mode (1 s, doubling to 5
  minutes): `vercel-queue` through the delivery's retry delay, `qstash` through a
  `503` and the `Upstash-Retry-Delay` the publish asked for. When the attempts are
  used up the callback answers `200`: the event is `failed` and the queue stops.
- A message the queue gave up on leaves the event `received`. The maintenance run
  (below) publishes such events again.
- `vercel-queue` uses the topic `starter-crm-webhook-jobs`, consumed by the Next.js
  variant's route file and bound to it in `vercel.json` (`queue/v2beta`). Vercel
  Queues is a public beta; `qstash` is the tested fallback and works on any host
  with a public address. The Python server has `qstash` and not `vercel-queue`.
- `qstash` verifies every callback before it reads the body: the
  `Upstash-Signature` header is an HS256 token signed with the current or the next
  signing key, issued by `Upstash`, inside its `nbf`/`exp` window, for this exact
  address, and carrying the SHA-256 of the exact body. Anything else is `401
  invalid_signature` and no handler runs.
- **Maintenance.** Without a loop, re-queuing events and pruning old ones is a
  scheduled request: on Vercel a daily cron calls `GET /internal/maintenance`,
  and on Netlify a daily scheduled function runs it.

### Netlify Async Workloads mode

`DC_WEBHOOKS=netlify-async` is the default on Netlify and works like the two
modes above, with Netlify's Async Workloads extension as the queue. The webhook
records the event, sends the event `starter-crm-webhook-job` with
`{"event_id": "<uuid>", "site_id": "<uuid>"}` to the site's router at
`/.netlify/functions/async-workloads-router`, authorized with `AWL_API_KEY`, and
answers `200` only after the router has accepted it, waiting at most 3 s. A
router that refuses or does not answer in time makes the webhook answer `503`,
and Drop Cowboy delivers it again.

- The event goes to the address of the request being served, so a deploy
  preview's events run in that preview against its own database. `DC_PUBLIC_URL`
  overrides that, and Netlify's `URL` is the fallback when no request is in flight.
- A workload function subscribed to that event reads the event from the store and
  runs the processor. No route of the core is involved, so there is no internal
  route for this mode.
- When a handler fails and another attempt is due, the workload asks Async
  Workloads to retry after the processor's backoff. The workload allows more
  retries than `DC_WEBHOOK_MAX_ATTEMPTS` can be, so the processor alone decides
  when an event has failed. An event that reaches a deploy using another mode is
  dropped without a retry.
- Node only: the Python server refuses the mode, and `qstash` is the tested
  fallback on Netlify.

### DynamoDB

`DC_STORE=dynamodb` keeps events, and `DC_DATA=dynamodb` keeps module documents,
in one table. Both servers read the layout below, so either can open the table
the other wrote. It is on-demand, with:

| Part | Name |
|---|---|
| Keys | `pk` (hash), `sk` (range), both strings |
| `gsi1` | `gsi1pk`, `gsi1sk`: events by state; module documents by collection |
| `gsi2` | `gsi2pk`, `gsi2sk`: a contact's events |
| Time to live | `expires_at` (seconds since the epoch) |

Every key begins with a kind and the site id, so two sites never meet in one
table. Index reads are eventually consistent (milliseconds); the store and data
providers are written so a stale index read can only delay work, never repeat
it. An item is at most 400 KB. An index key may not be an empty string, so an
absent value is written as `0`. `deploy/aws/ecs-express.yaml` creates exactly
this table, and `scripts/aws-template.test.mjs` fails if the two drift.

## Logging

A line is a JSON object `{ "time", "level", "message", "request_id"? }` plus
any fields (`DC_LOG_FORMAT=json`, the default in production), or a readable
line (`pretty`). With `DC_LOG_REQUESTS=on` every request writes one access
line with `method`, `path`, `status` and `duration_ms` (the path has no query
string).

Redaction is mandatory and applies to every sink, custom ones too: API
secrets, site tokens, access tokens, the passcode and loaded secrets are
replaced with `[redacted]`, phone numbers with `[redacted-phone]` and email
addresses with `[redacted-email]`. Nothing sent to a log may carry a secret,
and the conformance run fails if server output contains one.

## Observer hooks

`DC_OBSERVER` names a provider whose instance may implement any of these. Each
is awaited, receives one object, and an exception inside a hook is caught and
logged: it never changes the response.

| Hook | Payload |
|---|---|
| `onRequest` | `{ request_id, method, path, client_ip }` |
| `onResponse` | `{ request_id, method, path, status, duration_ms }` |
| `onError` | `{ request_id, method, path, message }`, for every `500 internal_error` |
| `onWebhook` | `{ request_id, event_id, event, duplicate }`, for every verified delivery |
| `onTokenMinted` | `{ request_id, user_id, purpose, cached, expires_at }` |

## Calling Drop Cowboy carefully

- **Token cache** (`server` mode, `DC_TOKEN_CACHE=on`). A minted site token is
  kept in memory per `(user id, purpose)` and returned again while it has
  more than 60 seconds left (`expires_at - now`). The cache is bounded, never
  logged and never shared between users. A cache hit does not call Drop
  Cowboy and does not count toward the per-user mint limit. `login` mode does
  not cache.
- **Retries.** Reads (`GET`) are retried: at most 3 attempts in total, after a
  network error or a `5xx`, or a `429` whose `Retry-After` is at most 2
  seconds (which is honoured), with jittered backoff. A timeout is not
  retried. A mint and every write are never retried: a second attempt could
  repeat a side effect.

## Modules

A **module** is a set of routes of your own, with data of your own, that lives
beside the starter's code instead of in it. Deals is the worked example; you add
more with `npm run new:module -- tickets` (see `CUSTOMIZE.md`, "Add a module").
Modules exist in `server` mode only, because their data belongs to a signed-in
user; in `login` and `mcp-session` mode the routes are not registered and answer
`404 not_found`.

- **Where they live.** Node: a folder `server/node/src/modules/<id>/index.js` whose
  default export is `{ id, routes(router), onEvent? }`. Python: a file
  `server/python/starter_crm/modules/<name>.py` defining `MODULE = Module(id=...,
  routes=..., on_event={...})`, where `id` is the file name with `_` read as `-`.
  An `id` is lowercase letters, digits and dashes, at most 32. Boot loads every
  module; a broken one fails boot with `invalid_module` rather than serving
  half an app.
- **Routes.** A module's routes are served under `/api/modules/<id>/...`. Creates
  and updates are `POST`, deletes are `DELETE`; there is no `PUT` or `PATCH`.
  Every route needs a signed-in user (`401 unauthenticated`), is checked for CSRF
  like any cookie-authenticated request, and counts against the per-user module
  [rate limit](#rate-limits). A route handler gets `{ user, data, log,
  dropcowboy, signal, params, query, body, request, reply }`, where `data` only
  ever sees this user's documents.
- **Errors.** A module fails with the same [error envelope](#error-envelope) as
  everything else. A thing that is not there, or belongs to someone else, is
  `404` with a code of the module's choosing (Deals: `deal_not_found`), and the
  two cases are indistinguishable.
- **Events.** A module can handle any webhook event with `onEvent` (`on_event`).
  Handlers run after the customer's own handlers, inside the same attempt: if one
  throws, the event is retried like any failed handler, so a handler **must be safe
  to run twice**. Its context has `data` over every user, `log`, `dropcowboy`,
  `signal`, `eventId` and `attempt`. They run before the event is purged, so a
  `contact.deleted` handler still sees what it needs.
- **Deals** (`/api/modules/deals`): `GET` lists the user's deals newest first
  (`stage`, `contact_id` and `archived=true|false|all`, default `false`); `POST`
  creates `{ title, contact_id?, amount_cents?, currency?, stage?, notes? }` and
  answers `201 { deal }`; `GET /:id` reads; `POST /:id` changes; `DELETE /:id`
  answers `200 { deleted: true, id }`. A `contact.deleted` event archives every
  deal of that contact for every owner, with `archived_reason: "contact_deleted"`.
  The request shapes are `server/schemas/deals.json`, one file for both servers.

## Module data

The data API behind modules: collections of JSON documents, each owned by one
user, kept by the provider `DC_DATA` selects (`docs/providers/data.md`).

- A document is `{ id, owner_id, created_at, updated_at, ...fields }`. `id` is a
  UUID and the times are ISO 8601 in UTC with milliseconds. The four are set by
  the data API and cannot be written by a module.
- A collection has `insert`, `get`, `list({ where, limit })`, `update` and
  `remove`. A user's view sees only their documents; reading, updating or
  deleting another user's id behaves exactly as a missing id.
- `list` is newest first, 100 by default and 500 at most. `where` is equality on
  string, number and boolean fields, type-strict (`1` does not match `true`), with
  field names of lowercase letters, digits and underscores.
- The `system` view used by event handlers spans every user of the site; its
  `insert` must name the `owner_id`.
- Two sites (`DROPCOWBOY_SITE_ID`) in one database never see each other's
  documents. The same data written by the Node server reads back unchanged on the
  Python server.

## Input validation

Module routes declare a schema for what they accept, and both servers read the
same file from `server/schemas/`, so they reject the same input the same way.
The schema language is a small subset of JSON Schema: `type` (also a list, for
`["string", "null"]`), `properties`, `required`, `additionalProperties: false`,
`enum`, `minLength`, `maxLength`, `minimum`, `maximum`, `pattern` (must match the
whole string), `format: "uuid"`, `items`, `maxItems` and `minProperties`.

- A body that does not fit is `400 invalid_request` with the first problem only,
  as a message naming the field (`title: must have at least 1 character.`).
- A body sent with a content type that is not `application/json` is
  `415 unsupported_media_type`; a body that is not JSON, or is the literal `null`,
  is `400 invalid_json`.
- An integer is a JSON number with no fractional part (`2` and `2.0` both are, in
  both servers); a boolean is never a number.
- `server/conformance/provider/schema-vectors.json` holds the cases both
  implementations pass.

## Routes

All JSON responses use `Content-Type: application/json`.

### `GET /healthz`

All modes. Cheap liveness check. `200 {"ok": true}` while the process is up.

### `GET /readyz`

All modes. Readiness for load balancers. Distinct from
`GET /api/dropcowboy/readiness` (the account checklist).

- `200 {"ok": true}` when the process can take traffic (store and module data ready, not draining).
- `503 {"ok": false, "reason": "draining"}` while shutting down.
- `503 {"ok": false, "reason": "store_not_ready"}` when the event store, the module data,
  the fan-out or the webhook queue cannot serve. The in-memory store is always ready.

### `GET /api/config`

All modes. Public runtime config for the browser. It must never contain a
secret.

```json
{
  "auth_mode": "login",
  "site_id": "3f8a2c1e-9b4d-4e7a-8c2f-1d5e6a7b8c9d",
  "api_base": "https://api-v2.dropcowboy.com",
  "cdn_version": null,
  "auth0": {
    "domain": "login.dropcowboy.com",
    "client_id": null,
    "audience": "https://api-v2.dropcowboy.com"
  }
}
```

- `site_id` and `cdn_version` are `null` when unset.
- `/api/config` does not name the identity: ask `GET /api/auth/session`
  (`server` mode only), which does.
- `auth0` is an object only when `auth_mode` is `login`, otherwise `null`.
  Its `client_id` is `null` when `AUTH0_CLIENT_ID` is empty.

### `POST /api/dropcowboy/token`

Registered in `server` and `login` modes; `404 not_found` in `mcp-session`.

The two modes differ only in who the caller is and which credential goes to
Drop Cowboy:

| | `server` | `login` |
|---|---|---|
| Caller | The [identity](#providers) chosen by `DC_IDENTITY` (`dev`, `passcode`, `oidc` or your own), which names the signed-in user. | The browser, signed in with Drop Cowboy, sending `Authorization: Bearer <access token>` |
| Credential sent upstream | `x-key` and `x-secret` | The browser's access token as `Authorization: Bearer <token>`, and no `x-key` or `x-secret` |
| `sub` sent upstream | The identity's user id | None |
| Drop Cowboy answers `401` | `502 upstream_auth_failed` | `401 login_expired` |

#### Login mode

- The access token is the Auth0 access token from "Sign in with Drop Cowboy"
  (the `auth0` settings in `/api/config`). It stands for the user, so
  the identity is not used on this route in `login` mode.
- `Authorization` must be the scheme `Bearer` (any case), one or more spaces,
  then a single token of `A-Z a-z 0-9 - . _ ~ + /` optionally followed by `=`
  padding (RFC 6750), and nothing else. Anything else, including no header, is
  `401 login_required`. This is checked before the body is read, and Drop
  Cowboy is not called.
- The server does **not** verify the token. It forwards it, always spelled
  `Bearer <token>`, and Drop Cowboy verifies it and decides whether this user
  may mint. A user without that permission gets `403 insufficient-scope`,
  passed through as usual.
- No `sub` is sent, so the minted token has none. Drop Cowboy already knows
  the account from the access token, and a `sub` taken from the browser would
  be an attribution claim nobody checked.
- A `401` from Drop Cowboy means the user's sign-in expired or was revoked, so
  the server answers `401 login_expired` and the front-end signs in again. In
  `server` mode the same `401` means this server's API key is wrong, which no
  browser can fix, so it stays `502 upstream_auth_failed`.
- The access token is a secret like the API key: it is never logged and never
  appears in a response.

#### Request

```json
{ "purpose": "session" }
```

The server maps `purpose` to scopes. **The browser can never choose scopes.**
Every other field in the body (`scope`, `sub`, `site_id`, `ttl_seconds`, ...)
is ignored, in both modes.

| `purpose` | Scopes | Used by |
|---|---|---|
| `session` | `["dialer:webrtc", "contacts"]` | The Dock: dialer, messenger, inbox and their contact panes |
| `contacts` | `["contacts"]` | The Contacts, Contact and Pipeline pages: contact REST calls, `dc-contact-card`, `dc-pipeline-board` |
| `campaigns` | `["campaigns"]` | The Campaigns page |
| `phone` | `["phone:hub"]` | The Phone page |

The lookup must be an own-key lookup: `constructor`, `__proto__`,
`toString` and similar are `400 invalid_purpose`. The `invalid_purpose`
message lists every purpose, in the order above.

Each purpose asks for the least its pages need. Drop Cowboy checks for a
connected carrier and a balance only when the scopes include `dialer:webrtc`
or `phone:hub`, so a `contacts` token mints for a team that has neither, and
the contacts pages keep working while the Dock shows why calling is not
available yet.

In `mcp-session` mode there is no mint route. Every page, the contacts pages
included, reuses the one token the MCP wrote to `.dropcowboy/session.json`,
with whatever scopes the MCP minted it with.

Upstream call in `server` mode:

```
POST {DROPCOWBOY_API_BASE}/phone/public/embed/token
x-key: {DROPCOWBOY_API_KEY}
x-secret: {DROPCOWBOY_API_SECRET}
Content-Type: application/json

{ "site_id": "{DROPCOWBOY_SITE_ID}", "sub": "{the identity's user id}", "scope": [...], "ttl_seconds": 900 }
```

Upstream call in `login` mode:

```
POST {DROPCOWBOY_API_BASE}/phone/public/embed/token
Authorization: Bearer {the browser's access token}
Content-Type: application/json

{ "site_id": "{DROPCOWBOY_SITE_ID}", "scope": [...], "ttl_seconds": 900 }
```

Neither call follows redirects, which would resend the credential elsewhere.

Upstream success is `{"data": {"token", "expires_at", ...}}`, where
`expires_at` is epoch milliseconds. Extra keys in the upstream body are
ignored.

Response `200`, with `Cache-Control: no-store`, and exactly these two keys:

```json
{ "token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...", "expires_at": 1790000000000 }
```

An upstream success without a string `token` and a numeric `expires_at` is
`502 upstream_error`.

When the mint refuses, the error carries `details.code`. The
[pass-through rules](#passing-through-drop-cowboy-errors) forward these codes
unchanged:

| Status | Code | When |
|---|---|---|
| `400` | `invalid_site_id` | `DROPCOWBOY_SITE_ID` is not a UUID |
| `402` | `insufficient_balance` | `session` or `phone`, with no allotment and no balance. Never `contacts` or `campaigns`. |
| `403` | `byoc_required` | `session` or `phone`, without a connected carrier. Never `contacts` or `campaigns`. An account with the sandbox gets a `session` token limited to 555 test numbers instead (readiness reports `sandbox_only: true`); the server passes it on like any other token. |
| `403` | `site_token_not_allowed` | The mint was called with a site token. In `server` mode it can't happen, because the server mints with its API key; in `login` mode it means the browser sent a site token where its access token belongs. |

### `GET /api/dropcowboy/readiness`

Registered in `server` and `login` modes; `404 not_found` in `mcp-session`.
The caller and the credential work exactly as on the
[token route](#post-apidropcowboytoken): the identity and `x-key`/`x-secret`
in `server` mode; the browser's `Authorization: Bearer <access token>`,
forwarded as is, in `login` mode, with the same `401 login_required` and
`401 login_expired`.

Upstream call: `GET {DROPCOWBOY_API_BASE}/register/public/integration-readiness`.
Drop Cowboy accepts either credential there. It needs `balance:read`: as a
scope on the API key, or as a permission of the signed-in user.

Response `200`, `Cache-Control: no-store`, containing only these fields
(anything else upstream sends, such as pool ids, plan ids, phone number lists or
integration ids, is dropped):

```json
{
  "embed_ready": false,
  "next_actions": ["connect_byoc", "add_funds"],
  "building_blocks_enabled": true,
  "byoc": {
    "connected": false,
    "providers": [{ "provider": "twilio", "enabled": true, "default": true }]
  },
  "funds": { "available": 0, "funds_ok": false },
  "allotment": { "sms": { "remaining": 100, "cap": 100 } },
  "numbers": { "count": 0 },
  "embed_resolve_contact_consent": false,
  "sandbox_only": true
}
```

- Booleans default to `false`, numbers to `0`, `next_actions` and `providers`
  to `[]` when upstream omits them.
- `allotment` keeps every key whose value has numeric `remaining` and `cap`,
  and only those two fields.
- `embed_resolve_contact_consent` is the team setting that lets embed texts and
  calls use consent already on the contact. It is off by default.
- `sandbox_only` is `true` only when upstream sends exactly `true`: the team
  has no carrier or no funds, so its session token reaches 555 test numbers
  (`+1 555 XXX XXXX`) only, and calls or texts to any other number are refused
  with `detail.code` `sandbox_only`. Accounts that predate the sandbox omit it,
  which reads as `false`.

### `GET /__dev/session`

Registered only in `mcp-session` mode. Development only.

An AI agent using the Drop Cowboy MCP mints a site token and writes it to
`<starter root>/.dropcowboy/session.json`:

```json
{ "token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...", "expires_at": 1790000000000, "site_id": "3f8a2c1e-9b4d-4e7a-8c2f-1d5e6a7b8c9d" }
```

The server re-reads the file on every request.

| Check | Result |
|---|---|
| Peer address is not loopback (`127.0.0.0/8`, `::1`, `::ffff:127.x.x.x`) | `403 loopback_only` |
| `Host` header hostname is not `localhost`, `127.0.0.1` or `[::1]` | `403 loopback_only` |
| File missing | `404 session_not_found`, with a message telling the developer how to create it |
| Not JSON, `token` not a non-empty string, or `expires_at` not a number `>= 1e12` (epoch ms) | `500 session_invalid` |
| `expires_at <= now` | `410 session_expired` |
| Otherwise | `200 {"token", "expires_at", "site_id"}` with `Cache-Control: no-store` |

- The peer address is the TCP socket's remote address. `X-Forwarded-For`,
  `Forwarded` and `X-Real-IP` must be ignored: anyone can send them.
- The `Host` check stops DNS rebinding, where a hostile page resolves its own
  name to `127.0.0.1` to read the token from the developer's machine.
- `site_id` is the file's value, else `DROPCOWBOY_SITE_ID`, else `null`.

### `POST /webhooks/dropcowboy`

All modes. Verifies a Drop Cowboy webhook delivery.

Headers sent by Drop Cowboy:

| Header | Value |
|---|---|
| `X-Signature` | `sha256=<hex digest>` |
| `X-Timestamp` | Unix time in seconds when the delivery was signed |
| `X-Signature-Version` | `v1` |
| `X-Event-Id` | The event's `event_id`. The same on every retry. |
| `X-Attempt` | `1`, `2` or `3` |

Verification, in this order:

1. `DROPCOWBOY_WEBHOOK_SECRET` unset: `503 webhook_not_configured`.
2. `X-Signature` or `X-Timestamp` missing or empty: `401 missing_signature`.
3. `X-Signature-Version` present and not `v1`: `401 invalid_signature`.
4. `X-Timestamp` not all digits, or `|now - X-Timestamp| > 300` seconds:
   `401 stale_timestamp`.
5. For each configured secret,
   `expected = "sha256=" + hex(HMAC_SHA256(key = secret, message = X-Timestamp + "." + raw_body))`,
   compared to `X-Signature` in constant time. The secret is used as its UTF-8
   bytes. No match for any secret: `401 invalid_signature`.
6. Parse the body as JSON. Failure: `400 invalid_json`.
7. The event id is `X-Event-Id`, else the body's `event_id`. Record the event
   in the [event store](#event-store), atomically. If the id was already
   recorded, answer `200 {"received": true, "duplicate": true}`. A duplicate
   whose first copy has not finished is queued again (it may never have been
   queued); a finished one is not run twice.
8. Queue the event for [processing](#processing). If it cannot be stored or
   queued, answer `503 webhook_not_queued` so Drop Cowboy retries. In `inline`
   mode a handler that throws (including one that gives up when its budget signal
   fires) answers `503 handler_failed`.
9. Answer `200 {"received": true}`. The event reaches `/api/events` when its
   handlers finish, not before.

- **Sign over the raw bytes received.** Parsing and re-serializing the JSON
  can change spacing and key order, and then no signature matches. Any
  framework JSON body parser must be kept off this route.
- Answer within a few seconds. Drop Cowboy waits 5 s, then retries `408`, `429`
  and `5xx` about 1 and 5 minutes later. It does not retry other `4xx`.
- Accept any `Content-Type`. Bodies up to 1 MB.
- In `store` and `bullmq` modes the answer takes only the time to store and
  queue the event, so a slow handler never delays it: the conformance suite
  checks a 200 in under 1 s with a handler that takes 2.5 s.
- An acknowledged event is never lost: it is in the store before the `200`.

Stored event, as pushed to `/api/events`:

```json
{
  "event_id": "d1f3a8e2-7c4b-4f9a-9d22-9c1e2f3a4b5c",
  "event": "contact.rvm.status",
  "event_at": 1774041600000,
  "received_at": 1774041601234,
  "attempt": 1,
  "data": { "contact_id": "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d", "status": "success" }
}
```

`event` and `event_at` are `null` and `data` is `{}` when absent. `attempt` is
`X-Attempt` as an integer, else `1`. `received_at` is epoch milliseconds.

### `GET /api/events`

All modes. Protected by the identity. A Server-Sent Events stream of
verified webhook events.

- `Content-Type: text/event-stream`, `Cache-Control: no-cache`.
- On connect, the server replays finished events from the store, oldest first,
  at most the newest 200. If the client sends `Last-Event-ID` and that id is a
  finished event, only the events that finished after it are replayed. An
  unknown id replays the newest 200. A client that reconnects to a different
  instance, or after a restart, therefore misses nothing that was kept.
- Only finished events are sent: processed ones, and failed ones whose attempts
  are used up. An event still waiting or between retries is not on the stream.
- An event is sent at most once per stream, whatever the fan-out delivers.
- With `DC_EVENTS_MAX_STREAM_SECONDS` above `0`, the server closes each stream
  after that long, with `retry: 1000`, so clients reconnect and load balance.
  On Vercel the default is 290 seconds, under the function's own limit, so a
  stream ends cleanly and the browser reconnects with `Last-Event-ID` instead of
  being cut off. On Netlify it is 25 seconds: Netlify documents 60 seconds for a
  streaming function, but a stream measured on a Free-plan site in October 2026
  was cut at 30.
- After the replay, even an empty one, the server sends one named event,
  `event: replayed` with `data: {}`. It marks where history ends and live
  events begin, so a freshly loaded page can list what it missed without
  announcing each item as new. Being named, it never reaches `onmessage`.
- Each event is one SSE message with the default event type, so the browser's
  `EventSource.onmessage` receives it:

  ```
  id: d1f3a8e2-7c4b-4f9a-9d22-9c1e2f3a4b5c
  data: {"event_id":"d1f3a8e2-...","event":"contact.rvm.status",...}

  ```

- The server should send a comment line (`: keepalive`) at least every 30 s. It
  sends one every 25 s, and every 5 s on Netlify, which lost a streamed write
  that followed about 10 s of silence and ended the stream.

### `GET /api/webhooks/status`

All modes. Protected by the identity. How webhook handling stands, for the Setup
page and `npm run doctor`:

```json
{
  "store": "postgres",
  "webhooks": "bullmq",
  "max_attempts": 8,
  "received": 0,
  "processed": 12,
  "failed": 0,
  "oldest_received_age_seconds": 0
}
```

`received` counts events waiting for their handlers, `failed` those that used up
their attempts, and `oldest_received_age_seconds` how long the longest-waiting
one has waited (`0` when none). If the store cannot be read, `503
event_store_unavailable`.

### Internal routes

Routes under `/internal` belong to the host and its queues, never to a browser.
They are not under the identity, the static files never answer them (a request for
one that does not exist is `404 not_found`, not the app), and each one checks its
own caller:

| Route | Mode | Caller | Check |
|---|---|---|---|
| `POST /internal/webhook-jobs` | `qstash` | QStash | The `Upstash-Signature` header (see above). |
| `POST /internal/queue/webhook-jobs` | `vercel-queue` | Vercel Queues | None in the app: Vercel keeps a queue-triggered route private, so only the queue can call it. |
| `GET /internal/maintenance` | Next.js variant on Vercel | Vercel Cron | `Authorization: Bearer <CRON_SECRET>`; 503 while `CRON_SECRET` is unset, 401 when it is wrong. |

The QStash route answers `200` with `{"outcome": "<processed|failed|skipped|missing>"}`
(or `{"ignored": true}` for a signed message that is not an event id), and `503
handler_failed` while a retry is due. The Vercel Queues route answers in the
queue's own format.

### Identity routes

Registered in `server` mode by the identity that needs them; `404 not_found`
elsewhere.

#### `GET /api/auth/session`

`server` mode, every identity. Never `401`: it is how a page learns whether to
show a sign-in screen. `200`, `Cache-Control: no-store`:

```json
{ "identity": "passcode", "signed_in": true, "user": { "id": "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d" } }
```

`identity` is `dev`, `passcode`, `oidc` or `custom`. `user` is `null` when not signed in. `email` and `name` appear when the
identity knows them. `dev` is always signed in.

#### `POST /api/auth/passcode`

`passcode` identity. Body `{ "passcode": "..." }`.

- Must be `application/json` (`415 unsupported_media_type`) and its `Origin`
  must pass the [CSRF check](#csrf) (`403 csrf_rejected`).
- Limited to 10 per minute per IP (`429 rate_limited`).
- A wrong or missing passcode is `401 invalid_passcode`. The comparison is
  constant-time.
- Success is `200 {"signed_in": true}` and sets the session cookie.

The cookie is `starter_crm_session`, or `__Host-starter_crm_session` when
`DC_ENV=production`, with `HttpOnly`, `SameSite=Lax`, `Path=/`,
`Max-Age=43200` (12 hours) and, in production, `Secure`. Its value is
`base64url(JSON {v, sub, iat, exp}).base64url(HMAC-SHA256)` signed with
`SHA-256("starter-crm-session|" + DROPCOWBOY_SITE_ID + "|" + DC_PASSCODE)`
as the HMAC key, `iat` and `exp` in epoch seconds, so changing the passcode
signs everyone out. The user id is `STARTER_CRM_USER_ID` when set, else the
UUIDv5 below of `passcode|owner`. An expired, tampered or malformed cookie is
simply not signed in.

#### `POST /api/auth/signout`

`passcode` identity. Same JSON and CSRF rules. `200 {"signed_in": false}` and
a `Set-Cookie` that expires the cookie.

#### The `oidc` identity

Protected routes read `Authorization: Bearer <JWT>`.

- Keys come from `DC_OIDC_JWKS_URL`, or from `jwks_uri` in
  `<issuer>/.well-known/openid-configuration`. Keys are cached, and re-fetched
  when an unknown `kid` appears, but never more than once every 2 seconds, so
  a stream of made-up key ids cannot turn this server into a load generator.
  A key already cached keeps verifying while the issuer is down.
- Only `RS256` and `ES256` are accepted. `alg: none`, `HS*` and anything else
  is `401 invalid_token`.
- `iss` must equal `DC_OIDC_ISSUER`, `aud` must include
  `DC_OIDC_AUDIENCE`, `exp` is required, `nbf` is honoured, with 60 seconds of
  clock skew.
- No token is `401 unauthenticated`; any other failure is `401 invalid_token`.
  Both carry `WWW-Authenticate: Bearer`. Discovery or key set failure is
  `503 identity_unavailable`.
- The user is `{ id, email?, name? }`. When `sub` is a UUID it is the id, lower-cased.
  Otherwise the id is `UUIDv5(namespace = DROPCOWBOY_SITE_ID, name = issuer + "|" + sub)`
  (RFC 4122, SHA-1), stateless and the same in every implementation.

#### CSRF

Applies to state-changing requests (every method except `GET` and `HEAD`) that
authenticate with a cookie, which is `POST /api/auth/passcode`,
`POST /api/auth/signout` and any `POST` or `DELETE` (module routes, for
example) protected by the `passcode` identity.

1. If `Origin` is present it must be an allowed origin: the origin of
   `DC_PUBLIC_URL`, else the request's own origin (with `DC_TRUST_PROXY`,
   from `X-Forwarded-Proto` and `X-Forwarded-Host`), plus every
   `DC_CORS_ORIGINS` entry. Otherwise `403 csrf_rejected`.
2. With no `Origin`, `Sec-Fetch-Site: same-origin` (or `none`) is accepted.
3. With neither, `403 csrf_rejected`.

Bearer-authenticated requests are not cookie-authenticated and are not
checked.

### Static files

All modes. `GET` requests outside `/api/`, `/__dev/`, `/webhooks/` and
`/healthz`:

| Path | Served from | If that folder has no `index.html` |
|---|---|---|
| `/shared/...` | `<root>/shared/` | Not applicable: see [shared modules](#shared-modules) |
| `/react/...` | `<root>/react/dist/` | `200 text/plain` explaining how to build or run the React app |
| everything else | `<root>/vanilla/` | `200 text/plain` explaining how to start a front-end |

When the folder has an `index.html`, a path with no matching file and an `Accept` header that
includes `text/html` gets that folder's `index.html`, so client-side routes such
as `/setup` and `/contacts/5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d` survive a reload.
Anything else that matches nothing is `404 not_found` in the error envelope.

No path may ever serve a file outside its folder, and names starting with `.`
(such as `.env`) are never served.

#### Caching and compression

Front-end files are served so a new deploy shows up on the next page load and
a big file is never fetched twice.

- **Hashed build assets** are `Cache-Control: public, max-age=31536000, immutable`.
  That is a file under `/react/assets/` whose name ends in a content hash of 8
  or more characters of `A-Z a-z 0-9 _ -` before the extension, such as
  `index-BWradlQu.js`. A changed file gets a new name, so the old one never
  goes stale.
- **Everything else** (pages, unhashed files, `/shared/` modules) is
  `Cache-Control: no-cache`: the browser may keep it but must revalidate. Each
  file carries an `ETag` and `Last-Modified`, and `If-None-Match` with a matching
  `ETag` is `304` with no body.
- **gzip.** `text/html`, `text/javascript`, `text/css`, `application/json`,
  `image/svg+xml` and `text/plain` files of 1024 bytes or more are sent with
  `Content-Encoding: gzip` when `Accept-Encoding` lists `gzip` and not as
  `gzip;q=0`. `Content-Length` is the compressed size. Those files always
  carry `Vary: Accept-Encoding`, compressed or not. Smaller files and other
  types are never compressed. The two servers compress with their language's
  zlib; the bytes may differ, the decompressed content does not.

#### Shared modules

`<root>/shared/` holds ES modules the front-ends share. The vanilla front-end
has no build step, so the browser imports them straight from `/shared/...`.

- A regular file inside `<root>/shared/` is served `200`. `.js` and `.mjs`
  files are `Content-Type: text/javascript` (a charset parameter may follow);
  browsers refuse to run a module served as anything else.
- Files only. There is no `index.html`, no directory listing and no
  client-route fallback, even for an `Accept: text/html` request. `/shared`,
  `/shared/`, any folder, a missing file and a dotfile are all
  `404 not_found` in the error envelope, so a broken import fails loudly.
- A path that would leave the folder is `404 not_found`: `..` segments, raw or
  percent-encoded (`%2e%2e`, `..%2f`). So is any path containing a backslash,
  raw or encoded as `%5c`. A backslash is a separator only on Windows, so
  refusing it everywhere keeps one URL meaning one thing on every machine.
- Served in every mode. A missing `<root>/shared/` folder just means every
  `/shared/...` path is `404 not_found`.

## Running the conformance suite

See [`conformance/README.md`](conformance/README.md). In short:

```bash
cd server/conformance
node run.js                                                   # the Node server
SERVER_LANG=python SERVER_CMD="python -m starter_crm" SERVER_CWD=../python node run.js   # the Python server
```
