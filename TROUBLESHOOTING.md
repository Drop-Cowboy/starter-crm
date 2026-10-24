# Troubleshooting

Find what you see below. Most problems are a missing setting, and
`npm run doctor` finds those for you: it checks your settings, that Drop
Cowboy accepts your API key, that its scripts can be reached, and, while
`npm start` is running in another terminal, that a signed test webhook gets
through. It never prints a secret.

Working with an AI assistant? Paste it what you see, word for word, and ask it
to check this page.

- [Start here](#start-here)
- [Messages in the app](#messages-in-the-app)
- [The server won't start](#boot-problem-codes): every code it can print
- [Other symptoms](#runtime-symptoms)
- [Useful commands](#useful-commands)

## Start here

### "Node 24 or later is required"

The starter needs Node.js 24 or later; an older one stops setup with that
message, or makes `npm start` fail with an error such as `SyntaxError`. Check
with `node -v`. Install the current version from <https://nodejs.org>, or, if
you use nvm, run `nvm install 24 && nvm use 24`. Then open a new terminal and
run `npm run setup` again.

### The page won't open

The browser says it can't reach the site, or the terminal shows an error.

- **Is the server running?** Run `npm start` and leave that terminal open. When
  it's ready it prints `Starter CRM server (...) on http://127.0.0.1:8080`.
  Open that address.
- **`No .env at the starter root`:** run `npm run setup` first.
- **`Could not listen on 127.0.0.1:8080`:** something else is using port
  8080. Stop it, or add `PORT=8081` to `.env` and open
  `http://127.0.0.1:8081`.
- **The server printed a `code` and stopped:** find the code under
  [The server won't start](#boot-problem-codes). Each one says what to fix.

### "Sign-in is not set up yet"

The starter is in `login` mode, which isn't available yet. Set
`DC_AUTH_MODE=server` in `.env`, put your API key and secret there (or run
`npm run setup` again), and restart.

### Call and Text are grayed out

The contact has no phone number. Edit the contact and add one, such as
`+1 555 555 0002`.

### A call or text says "Test numbers only"

Your account is in **sandbox mode**: it hasn't connected a carrier or added
funds yet, so it can call and text only free 555 test numbers. The contact page
says so under the buttons, and a call or text to any other number is refused.
Everything else works.

- To keep building, add a contact with a number such as `+1 555 555 0002`.
- To reach real phones, connect a carrier and add funds in the dashboard. The
  Setup page shows what's missing.

See [test numbers and sandbox mode](docs/how-it-works.md#test-numbers-and-sandbox-mode).

### The app asks for a business number

Texts to real phones come from one of your own numbers, so pick one on the
**Setup** page. Texting a 555 test number doesn't need one.

### A call doesn't start, or the other side can't hear you

The browser needs your microphone. The first time you call, it asks: click
**Allow**. If you clicked Block, click the icon at the left of the address bar,
allow the microphone for this site, and reload. Also check that the right
microphone is chosen in your computer's sound settings.

<a id="no-live-activity"></a>
### No live activity: the Activity panel stays empty

Replies to texts always appear in the Inbox; that needs nothing extra. The live
Activity panel and the alerts, such as a missed call, come from webhooks: Drop
Cowboy tells your server when something happens. If nothing arrives:

1. **Check the server log** when it starts. `DROPCOWBOY_WEBHOOK_SECRET is not
   set` means webhooks are refused; follow [Webhooks](docs/webhooks.md) to
   create one and save its secret.
2. **Check the address.** Drop Cowboy can't reach `127.0.0.1` or `localhost`.
   The webhook needs a public address, such as your deployed site or a tunnel,
   ending in `/webhooks/dropcowboy`.
3. **Test your server on its own:** `npm run webhook:test -- contact.created`
   should print `200 {"received":true}`. If it does, your server is fine and
   the problem is between Drop Cowboy and your address.
4. **See what Drop Cowboy sent:** in the dashboard, open **Developers > Logs**
   and the **Webhooks** tab. An `invalid_signature` answer means the secret in
   `.env` doesn't match the webhook's.

### "Widgets could not load"

The Building Blocks scripts didn't load (`cdn_unavailable`). Check your network,
and turn off any browser extension that blocks or rewrites scripts. If you set
`DC_CDN_VERSION`, it must be a release such as `3.33.16`, never `latest`.

### A deploy to Netlify or Vercel fails

- **The site shows an error, or the server won't start:** open the host's
  function log. The server prints a `code` there; look it up under
  [The server won't start](#boot-problem-codes). The usual one is
  `production_dev_identity`: a deployed site needs `DC_IDENTITY=passcode` and a
  `DC_PASSCODE`.
- **A setting is missing:** check the host's settings page against the table
  at the top of [Hosting](HOSTING.md). Nothing secret belongs in a file you
  commit.
- **Netlify:** `missing_awl_api_key` means the Async Workloads key isn't set.
  See the Netlify section of [Hosting](HOSTING.md#netlify).
- **Vercel:** `serverless_store` means the server needs a shared store. See the
  Vercel section of [Hosting](HOSTING.md#vercel).

Then run `npm run test:deployed -- --url https://your-site` to check it.

## Messages in the app

When something fails, the app explains it in plain words, and
`explainError()` in [`shared/errors.js`](shared/errors.js) holds every
explanation. These are the ones that need more than the app can say.

| You see | Why | Fix |
|---|---|---|
| **Test numbers only** (`sandbox_only`, 403) when calling or texting | The team is in sandbox mode (no carrier, or no funds), so it can reach only 555 test numbers. | Try a contact with a 555 number, or connect and fund a carrier. See [test numbers and sandbox mode](docs/how-it-works.md#test-numbers-and-sandbox-mode). |
| **Too many test calls at once** (`sandbox_concurrency`) | A team can have up to 5 calls to 555 numbers at a time. | Hang up one, then try again. |
| **Connect your carrier** (`byoc_required`, 403) when the Dock or Phone loads | Calling and texting run on your own carrier account, and none is connected. | Connect a carrier (BYOC) in the Drop Cowboy dashboard. Contacts and Pipeline keep working meanwhile. |
| **Add funds to continue** (`insufficient_balance`, 402) | The plan allotment and the prepaid balance are both used up. Only `session` and `phone` tokens check this. | Add funds in the dashboard. |
| **Consent needed** (`consent_required`, with a `reason`) | A text or call to a US number had no consent. Reasons: `no_granted_consent`, `phone_mismatch`, `opted_out`, `contact_dnc`, `contact_not_found`, `consent_record_invalid`. | Record consent first, or have a team admin turn on **Use existing contact consent** on the Building Blocks page and make sure the send carries `contact_id`. Opt-outs, STOP replies and Do Not Call always block. |
| `sms_registration_required` (400) when sending a text | The business number is not on a registered 10DLC brand and campaign, so US carriers would not deliver it. | Register the brand and campaign in Drop Cowboy, or pick a registered number on the Setup page. |
| `acting_user_required` (403) when the Dock connects | The API key that minted the token has no Drop Cowboy user behind it, and calls are logged under that user. | Create the API key while signed in as a team member, and mint with it. |
| **The site id is not a UUID** (`invalid_site_id`, 400), or the server will not start | `DROPCOWBOY_SITE_ID` is not a UUID. | Generate one with `node -e "console.log(crypto.randomUUID())"`. |
| **Your sign-in expired** (`login_expired`, 401) | Login mode: your Drop Cowboy sign-in expired or was revoked. | Sign in again. |
| **The server's API key was refused** (`upstream_auth_failed`, 502) | Server mode: Drop Cowboy refused the server's API key. | Copy `DROPCOWBOY_API_KEY` and `DROPCOWBOY_API_SECRET` again from **Developers > API Keys**, and check the key wasn't deleted. |
| **No development session yet** (`session_not_found`, 404) | MCP session mode, and `.dropcowboy/session.json` does not exist. | Ask your agent to mint and write the file. `session_expired` (410) means mint again. |
| **Widgets could not load** (`cdn_unavailable`) | The manifest or a bundle did not load, or a bundle did not match its integrity hash. | Check `DC_CDN_VERSION`: it must be a release of 3.33.1 or later, which publish the manifest. A proxy or browser extension that rewrites scripts also breaks the integrity check. |
| **Request did not reach its server** (`network_error`), with a CORS error in the console | The embed and public routes on `app-api-v2.dropcowboy.com` answer any origin, so this is usually a call to another route or host, or a proxy that strips response headers. | Call only the routes the widgets and `shared/contacts-api.js` use from the browser, and everything else from your server. |
| A `curl` or headless-browser preflight to `api-v2.dropcowboy.com` gets `403 ForbiddenException` | A bot filter in front of `api-v2` refuses `OPTIONS` requests from curl's user agent and other bot-like agents. It is not a CORS answer. | Test CORS from a real browser. The starter's browser never calls `api-v2`; only its server does. |
| A `dc-session-expired` event | A widget could not refresh its token. | Reload. If it repeats, check the token route and the server log. |

<a id="boot-problem-codes"></a>
## The server won't start

When a setting is wrong, the server prints a problem as `code`, `message`,
`fix` and `docs`, then stops. The `docs` link points to the matching code
below. No secret value ever appears in those fields.

### `renamed_env`

`SAMPLE_USER_ID` or `SAMPLE_CRM_ROOT` is set. Those names were retired; there
are no aliases.

**Fix:** rename to `STARTER_CRM_USER_ID` or `STARTER_CRM_ROOT`, or unset the
old name.

### `invalid_auth_mode`

`DC_AUTH_MODE` is not one of `server`, `login` or `mcp-session`.

**Fix:** set `DC_AUTH_MODE=server` (the default production pattern).

### `invalid_env`

`DC_ENV` is not `development` or `production`.

**Fix:** set `DC_ENV=development` locally, or `production` in deploy templates.

### `invalid_identity`

`DC_IDENTITY` is not `dev`, `passcode`, `oidc` or a relative path to your own
provider file (it must start with `./` or `../`).

**Fix:** set `DC_IDENTITY=passcode`, `oidc` or `dev`, or point it at your own
file, such as `./my-identity.js`. See `docs/providers/identity.md`.

### `identity_requires_server_mode`

`DC_IDENTITY` is set to something other than `dev` while `DC_AUTH_MODE` is
`login` or `mcp-session`. Only `server` mode uses an identity.

**Fix:** unset `DC_IDENTITY`, or set `DC_AUTH_MODE=server`.

### `production_dev_identity`

`DC_ENV=production` with `DC_IDENTITY=dev`. Production refuses the
`dev` identity, which would hand a dialer-scoped token to
anyone.

**Fix:** run with `DC_ENV=development` locally, or set a real identity:
`DC_IDENTITY=passcode` with `DC_PASSCODE`, `DC_IDENTITY=oidc`, or your own.

### `production_mcp_session`

`DC_ENV=production` with `DC_AUTH_MODE=mcp-session`. That mode is a local
file handoff only.

**Fix:** set `DC_AUTH_MODE=server` (or `login`) for production.

### `invalid_api_base`

`DROPCOWBOY_API_BASE` is not an `http(s)` URL.

**Fix:** set it to `https://api-v2.dropcowboy.com`, or leave it unset.

### `invalid_port`

`PORT` is not a whole number from 0 to 65535.

**Fix:** set `PORT=8080` (or another free port).

### `invalid_timeout`

`DROPCOWBOY_TIMEOUT_MS` is not a positive whole number.

**Fix:** set `DROPCOWBOY_TIMEOUT_MS=10000`.

### `invalid_shutdown_grace`

`DC_SHUTDOWN_GRACE_SECONDS` is outside 1–300.

**Fix:** set `DC_SHUTDOWN_GRACE_SECONDS=10`.

### `invalid_trust_proxy`

`DC_TRUST_PROXY` is not a whole number from 0 to 32.

**Fix:** set `DC_TRUST_PROXY=0` locally, or `1` behind a single reverse proxy.

### `invalid_public_url`

`DC_PUBLIC_URL` is not an `http(s)` origin (no path).

**Fix:** set `DC_PUBLIC_URL=https://crm.example.com`, or leave it unset locally.

### `invalid_site_id`

`DROPCOWBOY_SITE_ID` is set but is not a UUID.

**Fix:** generate one with `node -e "console.log(crypto.randomUUID())"` and
keep it stable per deployed app.

### `missing_site_id`

`DROPCOWBOY_SITE_ID` is required in `server` and `login` modes.

**Fix:** set one UUID and keep it stable; it partitions the embed inbox.

<a id="missing_api_key"></a>
<a id="missing_api_secret"></a>
### `missing_api_key` / `missing_api_secret`

Required in `server` mode.

**Fix:** create a key under **Developers > API Keys** (it needs a paid plan),
then run `npm run setup` and paste them, or set both variables in `.env`
(mode 0600).

<a id="missing_user_id"></a>
<a id="invalid_user_id"></a>
### `missing_user_id` / `invalid_user_id`

`STARTER_CRM_USER_ID` is required with the `dev` identity in `server` mode and
must be a UUID (with `passcode` it is optional but must still be a UUID when
set; `oidc` ignores it).

**Fix:** set a UUID, or choose `DC_IDENTITY=passcode` or `oidc`.

<a id="missing_passcode"></a>
<a id="weak_passcode"></a>
### `missing_passcode` / `weak_passcode`

`DC_IDENTITY=passcode` needs `DC_PASSCODE`, and it must be at least 12
characters.

**Fix:** set `DC_PASSCODE` to a longer passphrase, for example three random
words. It is a secret: keep it out of git and logs, or load it with
`DC_SECRETS=file`.

<a id="missing_oidc_issuer"></a>
<a id="missing_oidc_audience"></a>
<a id="invalid_oidc_issuer"></a>
<a id="invalid_oidc_jwks_url"></a>
### `missing_oidc_issuer` / `missing_oidc_audience` / `invalid_oidc_issuer` / `invalid_oidc_jwks_url`

`DC_IDENTITY=oidc` needs `DC_OIDC_ISSUER` (an `https` URL; plain `http` only
for `localhost`) and `DC_OIDC_AUDIENCE`. `DC_OIDC_JWKS_URL`, when set, must be
an `http(s)` URL.

**Fix:** copy the issuer and audience from your sign-in service. The issuer
must equal the token's `iss` exactly, including any trailing slash.
`CUSTOMIZE.md` has the values for Auth0, Clerk, Supabase and Firebase.

<a id="unknown_provider"></a>
<a id="invalid_provider"></a>
### `unknown_provider` / `invalid_provider`

A `DC_<KIND>` variable names a built-in that does not exist, or a path that
could not be loaded or does not export `name`, `configKeys`, `validate` and
`create`.

**Fix:** use a built-in name, or a relative path from the starter root such as
`./my-identity.js`. Run `npm run conformance:provider -- <kind> <path>`
(`python -m starter_crm.provider_check <kind> <path>` for Python) to see what
is wrong.

<a id="invalid_csp"></a>
<a id="invalid_cors_origins"></a>
### `invalid_csp` / `invalid_cors_origins`

`DC_CSP` must be `report-only`, `enforce` or `off`. `DC_CORS_ORIGINS` is a
comma-separated list of exact origins such as `https://crm.example.com`: no
path, no `*`.

**Fix:** correct the value, or leave `DC_CORS_ORIGINS` empty for same-origin.

<a id="invalid_rate_limit"></a>
<a id="invalid_token_cache"></a>
### `invalid_rate_limit` / `invalid_token_cache`

`DC_RATE_LIMIT` must be `memory`, `redis`, `off` or a relative path. `DC_TOKEN_CACHE`
must be `on` or `off`.

**Fix:** correct the value.

<a id="invalid_secrets_provider"></a>
<a id="missing_secrets_dir"></a>
<a id="invalid_secrets_refresh"></a>
### `invalid_secrets_provider` / `missing_secrets_dir` / `invalid_secrets_refresh`

`DC_SECRETS` must be `env`, `file`, `doppler`, `infisical`, `vault`, `1password`
or a relative path. `file` needs `DC_SECRETS_DIR` to be a readable folder.
`DC_SECRETS_REFRESH_SECONDS` must be a whole number from 0 to 86400.

**Fix:** correct the value, and check the folder is mounted where the server
runs.

<a id="missing_doppler_token"></a>
<a id="missing_infisical_setting"></a>
<a id="missing_vault_setting"></a>
<a id="missing_onepassword_setting"></a>
### `missing_doppler_token` / `missing_infisical_setting` / `missing_vault_setting` / `missing_onepassword_setting`

A secret manager needs its own settings before it can be asked for anything,
and the credential that signs in to it cannot come from the manager itself. The
message names the variable that is missing.

**Fix:** set it in the host's environment (a platform secret, not a file in the
repository). The variables for each manager are in `docs/providers/secrets.md`.

### `invalid_secrets_url`

`DOPPLER_API_URL`, `INFISICAL_URL` or `VAULT_ADDR` is not a URL, has a user name
or password in it, or is `http` for a host that is not `localhost`. A credential
sent over plain `http` can be read on the way.

**Fix:** use an `https` address. Only a loopback address, such as a local
OpenBao, may use `http`.

<a id="invalid_vault_auth"></a>
<a id="invalid_vault_path"></a>
### `invalid_vault_auth` / `invalid_vault_path`

`vault` signs in with `VAULT_TOKEN` or with `VAULT_ROLE_ID` and
`VAULT_SECRET_ID`, never both. `VAULT_PATH` may not contain `..`.

**Fix:** set one kind of credential, and give the path as it appears under the
mount, for example `apps/starter-crm`.

### `invalid_onepassword_setting`

`OP_VAULT` or `OP_ITEM` contains `/`, `?` or `#`, which would change which item the
reference points at.

**Fix:** use the vault and item names only.

### `secret_load_failed`

The secrets provider could not read at boot. The message names the manager and
the HTTP status or the reason, and never a value or a credential. `HTTP 401` or
`403` is a wrong or expired credential or a policy that cannot read the path.
`HTTP 404` (Vault) is a wrong mount or path, and the message names both.
"could not be reached" is the network, DNS or the address. A refused redirect
means the address is not the manager's own.

**Fix:** check the credential and its permissions in the manager, then the
address. After boot the same failure only logs a warning and keeps the last
good values until the manager is back.

<a id="invalid_log_format"></a>
<a id="invalid_log_requests"></a>
<a id="invalid_log_provider"></a>
<a id="invalid_observer"></a>
### `invalid_log_format` / `invalid_log_requests` / `invalid_log_provider` / `invalid_observer`

`DC_LOG_FORMAT` must be `pretty` or `json`, `DC_LOG_REQUESTS` `on` or `off`,
`DC_LOG` `console` or a relative path, and `DC_OBSERVER` a relative path.

**Fix:** correct the value.

<a id="invalid_store"></a>
<a id="invalid_fanout"></a>
<a id="invalid_webhooks_mode"></a>
### `invalid_store` / `invalid_fanout` / `invalid_webhooks_mode`

`DC_STORE` must be `memory`, `sqlite`, `postgres`, `redis`, `dynamodb` or a relative path.
`DC_FANOUT` must be `local`, `poll`, `redis`, `postgres` or a relative path.
`DC_WEBHOOKS` must be `store`, `bullmq`, `sqs`, `inline` or a relative path.

**Fix:** correct the value, or leave `DC_FANOUT` and `DC_WEBHOOKS` empty to get
the default for your store.

<a id="invalid_data"></a>
<a id="data_provider_required"></a>
### `invalid_data` / `data_provider_required`

`DC_DATA`, where your modules keep their data, must be `memory`, `sqlite`,
`postgres`, `dynamodb` or a relative path. Empty follows `DC_STORE`, which works for
`memory`, `sqlite`, `postgres` and `dynamodb`. `DC_STORE=redis` (or a store of your own)
cannot hold module data, so in server mode `DC_DATA` has to be set.

**Fix:** set `DC_DATA=postgres` (with `DC_DATABASE_URL`), `DC_DATA=dynamodb` (on AWS) or
`DC_DATA=sqlite` (one instance), or the path of your own data provider.

### `invalid_module`

A module under `server/node/src/modules/` or `server/python/starter_crm/modules/`
is broken: no `id`, an `id` that does not match its folder or file name, no
routes, an id used twice, or a failure while it set itself up. The message names it.

**Fix:** correct it, or delete it. `CUSTOMIZE.md`, "Add a module", has the shape.

<a id="store_not_shared"></a>
<a id="fanout_needs_postgres"></a>
<a id="worker_needs_shared_store"></a>
<a id="worker_needs_fanout"></a>
### `store_not_shared` / `fanout_needs_postgres` / `worker_needs_shared_store` / `worker_needs_fanout`

The settings cannot work together. A fan-out between instances or a queue needs
a store that outlives one process (`DC_STORE=memory` does not). `DC_FANOUT=postgres`
needs `DC_STORE=postgres`. `DC_WORKER_IN_PROCESS=off` puts the worker in another
process, so the store must be one it can read (`sqlite` on the same machine,
`postgres` or `redis`) and the fan-out must cross processes (`poll`, `redis` or
`postgres`).

**Fix:** use a durable store, or leave the worker in the web process.

<a id="missing_redis_url"></a>
<a id="invalid_redis_url"></a>
<a id="missing_database_url"></a>
<a id="invalid_database_url"></a>
### `missing_redis_url` / `invalid_redis_url` / `missing_database_url` / `invalid_database_url`

`DC_STORE=redis`, `DC_FANOUT=redis`, `DC_RATE_LIMIT=redis` and `DC_WEBHOOKS=bullmq`
need `DC_REDIS_URL` (`redis://` or `rediss://`). `DC_STORE=postgres` needs
`DC_DATABASE_URL` (or `DATABASE_URL`), a `postgres://` or `postgresql://` URL.

**Fix:** set the URL, in `.env` or your secrets provider. The message never
prints its password.

<a id="insecure_redis_url"></a>
<a id="insecure_database_url"></a>
### `insecure_redis_url` / `insecure_database_url`

`DC_ENV=production` and the Redis or Postgres host is not local, but the URL has
no TLS. Plain connections cross the network in the clear.

**Fix:** use `rediss://`, and `?sslmode=require` on the Postgres URL. For a
database on a private network you control, such as the Compose project, set
`DC_INSECURE_PRIVATE_SERVICES=on`.

<a id="missing_aws_region"></a>
<a id="invalid_aws_endpoint"></a>
<a id="insecure_aws_endpoint"></a>
<a id="invalid_dynamodb_table"></a>
### `missing_aws_region` / `invalid_aws_endpoint` / `insecure_aws_endpoint` / `invalid_dynamodb_table`

Something that talks to AWS (`DC_STORE=dynamodb`, `DC_DATA=dynamodb`, `DC_WEBHOOKS=sqs`,
`DC_SECRETS=aws-secrets-manager` or `aws-ssm`) has no region, or a setting it reads is
wrong. `AWS_ENDPOINT_URL` must be a URL, and `https` when `DC_ENV=production` unless the host
is local. A DynamoDB table name is 3 to 255 letters, digits, underscores, dots and dashes.

**Fix:** set `AWS_REGION` (ECS sets it for you), unset `AWS_ENDPOINT_URL` to use AWS, and
leave `DC_DYNAMODB_TABLE` unset or name a valid table. The credentials are never a setting
here: the SDK finds them, so on ECS give the task role access to the table.

<a id="missing_sqs_queue_url"></a>
<a id="invalid_sqs_queue_url"></a>
<a id="insecure_sqs_queue_url"></a>
### `missing_sqs_queue_url` / `invalid_sqs_queue_url` / `insecure_sqs_queue_url`

`DC_WEBHOOKS=sqs` needs `DC_SQS_QUEUE_URL`, the queue's URL (the CloudFormation template
prints it as `WebhookQueueUrl`). It must be a URL, and `https` in production.

**Fix:** set the queue URL, or choose another `DC_WEBHOOKS` mode.

<a id="missing_aws_secret_id"></a>
<a id="missing_aws_ssm_path"></a>
<a id="invalid_aws_ssm_path"></a>
### `missing_aws_secret_id` / `missing_aws_ssm_path` / `invalid_aws_ssm_path`

`DC_SECRETS=aws-secrets-manager` needs `DC_AWS_SECRET_ID`, and `aws-ssm` needs
`DC_AWS_SSM_PATH`, which starts with `/` and uses letters, digits, `_`, `.` and `-`.

**Fix:** set it. If boot then reports `secret_load_failed` with a `403`, the task role cannot read
that secret or path.

<a id="invalid_redis_cluster"></a>
<a id="bullmq_cluster_unsupported"></a>
### `invalid_redis_cluster` / `bullmq_cluster_unsupported`

`DC_REDIS_CLUSTER` is `on`, `1`, `true`, `off`, `0`, `false` or empty. The Python server cannot run
`DC_WEBHOOKS=bullmq` against a Redis Cluster, because BullMQ for Python takes only a single-server client.

**Fix:** correct the value; for the second, set `DC_WEBHOOKS=store` (or `sqs` on AWS), or run the Node server.

<a id="serverless_store"></a>
<a id="serverless_webhooks_store"></a>
<a id="serverless_worker"></a>
<a id="serverless_fanout"></a>
### `serverless_store` / `serverless_webhooks_store` / `serverless_worker` / `serverless_fanout`

The server is running on Vercel or Netlify (it checks `VERCEL` and `NETLIFY`), where nothing runs between requests and each
request may land on a different instance. So an event store, webhook mode, worker or fan-out that lives in one process
cannot work: `memory` and `sqlite` stores lose events, `DC_WEBHOOKS=store` or `bullmq` needs a worker that never runs, and a
`local` fan-out never reaches the other instances.

**Fix:** use `DC_STORE=postgres` (or `redis` or `dynamodb`), `DC_WEBHOOKS=vercel-queue` on Vercel or `netlify-async` on
Netlify (or `qstash` or `inline` on either), leave `DC_WORKER_IN_PROCESS` unset, and `DC_FANOUT=poll` or `redis`. On
Netlify, creating the site's Netlify Database sets the address the `postgres` store reads. See the Vercel and Netlify
sections of `HOSTING.md`.

<a id="missing_qstash_setting"></a>
<a id="missing_qstash_public_url"></a>
<a id="invalid_qstash_public_url"></a>
<a id="insecure_qstash_public_url"></a>
<a id="invalid_qstash_url"></a>
### `missing_qstash_setting` / `missing_qstash_public_url` / `invalid_qstash_public_url` / `insecure_qstash_public_url` / `invalid_qstash_url`

`DC_WEBHOOKS=qstash` needs `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY`, and a public address
QStash can call back (`DC_PUBLIC_URL`, or on Vercel the project's production domain). That address must be a
URL and `https` in production. `QSTASH_URL` is for a QStash stand-in and must be a URL too.

**Fix:** copy the three values from the Upstash QStash page, and set `DC_PUBLIC_URL` to the address of the deployed app.

<a id="vercel_queue_off_vercel"></a>
<a id="vercel_queue_node_only"></a>
### `vercel_queue_off_vercel` / `vercel_queue_node_only`

`DC_WEBHOOKS=vercel-queue` hands events to Vercel Queues, which exists only for functions running on Vercel, and only the Node
server (the Next.js variant) can use it.

**Fix:** use `qstash` or `inline` anywhere else, and on the Python server.

<a id="netlify_async_off_netlify"></a>
<a id="missing_awl_api_key"></a>
<a id="netlify_async_node_only"></a>
### `netlify_async_off_netlify` / `missing_awl_api_key` / `netlify_async_node_only`

`DC_WEBHOOKS=netlify-async` hands events to Netlify's Async Workloads, which exists only for functions running on Netlify,
and only the Node server (the Netlify variant) can use it. Its router refuses an event without the key it was given,
`AWL_API_KEY` (or a rotation key, `AWL_API_KEY_P<n>`).

**Fix:** install the Async Workloads extension for the team. On a Starter team, also create a key for the site under
**Project configuration > Developer settings > Async Workloads**; on other plans the extension creates one. Then redeploy.
Off Netlify, and on the Python server, use `qstash` or `inline`.

<a id="invalid_event_retention"></a>
<a id="invalid_max_stream_seconds"></a>
<a id="invalid_fanout_poll"></a>
<a id="invalid_outbox_poll"></a>
<a id="invalid_webhook_attempts"></a>
<a id="invalid_handler_budget"></a>
<a id="invalid_worker_in_process"></a>
<a id="invalid_webhook_handlers"></a>
### `invalid_event_retention` / `invalid_max_stream_seconds` / `invalid_fanout_poll` / `invalid_outbox_poll` / `invalid_webhook_attempts` / `invalid_handler_budget` / `invalid_worker_in_process` / `invalid_webhook_handlers`

A number is out of range or not a whole number. `DC_EVENT_RETENTION_HOURS` is
1 to 8760, `DC_EVENTS_MAX_STREAM_SECONDS` 0 to 86400, `DC_FANOUT_POLL_MS` and
`DC_OUTBOX_POLL_MS` 100 to 60000, `DC_WEBHOOK_MAX_ATTEMPTS` 1 to 50 and
`DC_WEBHOOK_HANDLER_BUDGET_MS` 100 to 4500. `DC_WORKER_IN_PROCESS` is `on` or
`off`. `DC_WEBHOOK_HANDLERS` is a relative path to a file that exports `handlers`.

**Fix:** correct the value.

## Runtime symptoms

| Symptom | Likely cause |
|---|---|
| Webhooks return `503` | `DROPCOWBOY_WEBHOOK_SECRET` unset. Create a webhook and put its signing secret in `.env`. |
| Webhooks return `invalid_signature` | Wrong secret, or a JSON body parser ran before the raw-body verifier. |
| Inbox looks empty after redeploy | You generated a new `DROPCOWBOY_SITE_ID`. Keep one UUID per app. |
| Contacts pages fail with `byoc_required` | Using a `session` token for contacts. Mint purpose `contacts` instead. |
| Sign-in page keeps appearing (passcode) | The cookie is not being kept. In production the cookie is `Secure`, so use `https`. Changing `DC_PASSCODE` signs everyone out. |
| `401 invalid_token` (oidc) | `DC_OIDC_ISSUER` does not equal the token's `iss` (check a trailing slash), `DC_OIDC_AUDIENCE` is not in `aud`, or the token is not RS256 or ES256. |
| `401 unauthenticated` (oidc) | The page never sent a token. Register `setAuthHeaderProvider` (see `CUSTOMIZE.md`). |
| `503 identity_unavailable` | The server could not reach the issuer's key set. A key already cached keeps working. Check `DC_OIDC_JWKS_URL`, egress and DNS. |
| `403 csrf_rejected` | A cookie-authenticated `POST` or `DELETE` came from an origin the server does not trust. Set `DC_PUBLIC_URL` to the origin you serve, and `DC_TRUST_PROXY` behind a proxy. |
| `400 invalid_request` from a module | The body, query or id does not fit the module's schema in `server/schemas/`. The message names the first field that is wrong. |
| `415 unsupported_media_type` from a module | The request has a body that is not `Content-Type: application/json`. |
| A module route answers `404 not_found` | Modules run only in `DC_AUTH_MODE=server`, and the id must match the folder or file name. Restart after adding one. |
| `429 rate_limited` | Read `Retry-After`. Behind a proxy without `DC_TRUST_PROXY`, every user shares one IP and one limit. |
| Webhooks answer `503 webhook_not_queued` | The event was stored but the queue (Redis for `bullmq`) was unreachable. Drop Cowboy retries it. Check `DC_REDIS_URL` and `/readyz`. |
| Every webhook answers `503 webhook_not_queued` on Netlify | The Async Workloads router refused the event. The function log names its HTTP status: `404` means the build injected no router (look for `async-workloads-router` under `.netlify/functions-internal` in the deploy log, and keep `NODE_OPTIONS` in `netlify.toml`); `401` means `AWL_API_KEY` does not match the key Async Workloads has; `502` means the router crashed, and the `async-workloads-router` function's own log says why (`Cannot find package '@netlify/async-workloads'` means the root `package.json` lost that dependency). A timeout means the router took longer than 3 seconds. |
| Webhooks answer `503 handler_failed` | `DC_WEBHOOKS=inline` and a handler threw. Fix the handler, or use `store` or `bullmq` so a failure is retried out of the request. |
| Setup shows events waiting for a long time | No worker is running. With `DC_WORKER_IN_PROCESS=off`, start `npm run worker`. |
| Setup shows failed events | A handler kept throwing. Read the `Handler failed` log lines, fix the handler, then `npm run webhooks:replay -- --all-failed`. |
| A live page misses events from another instance | The fan-out is `local`. Use a shared store, which turns on `redis`, `postgres` or `poll`. |
| `503 event_store_unavailable` or `/readyz` says `store_not_ready` | The server cannot reach its store. Check the URL, TLS and the network; it recovers by itself once the store answers. |
| Python server stalls with many live pages | Each open stream holds a Gunicorn thread. Raise `GUNICORN_THREADS` above the open streams. |
| `GET /readyz` returns `503` with `draining` | The process is shutting down; load balancers should stop sending traffic. |
| Process hangs on deploy with a browser open | Older builds waited forever on SSE. Current builds drain within `DC_SHUTDOWN_GRACE_SECONDS`. |

## Useful commands

```bash
npm run doctor                 # config + reachability + self-webhook
npm run webhook:test -- contact.created
npm run webhooks:failed        # events whose handlers gave up
npm run webhooks:replay -- <event_id>   # or --all-failed
npm run migrate:status         # migrations run and pending
npm run test:live              # real API (needs STARTER_CRM_LIVE_* secrets)
npm run test:live:sweep        # delete leftover live-* contacts older than a day
```

Tunnel recipe for inbound webhooks while developing:

```bash
cloudflared tunnel --url http://127.0.0.1:8080
# Point a Drop Cowboy webhook at https://….trycloudflare.com/webhooks/dropcowboy
```
