# Changelog

All notable changes to the Starter CRM. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The starter is not
published as a package; a "version" here is a state of this repository.

## Unreleased

### Security

- **Next.js 16.4.1.** The Vercel variant (`server/nextjs`) pins `next` at 16.4.1, which is the patched release for GHSA-2464-fhr4-w9xw (Image Optimization / `sharp` RCE), GHSA-673q-mjm6-r5xr (`use cache` typed-array RCE), and CVE-2026-94482 (Server Action CPU DoS). This app is route handlers over the Node core (`dynamic = force-dynamic`); it does not use `next/image`, `use cache`, or Server Actions. The bump is so a customer who copies the Vercel variant is not sitting on a known-vulnerable pin.
- **Vite 8.3.5.** The React frontend (`react/`) pins `vite` at 8.3.5, past CVE-2026-112942 (Windows `launch-editor` command injection, 8.0.0–8.1.5 and 8.3.0–8.3.2) and the October 2026 `server.fs` advisories (GHSA-rq7h-c2jc-7f22, GHSA-vfpm-58rq-9qcg). `server/node` overrides Vitest’s transitive Vite to the same version. This app does not expose the Vite dev server to the network; the bump is so a customer who copies the React frontend is not sitting on a known-vulnerable pin.

### Added

- **Test numbers (the sandbox).** Every seed, demo and fixture contact now has
  a 555 test number (+1 555 XXX XXXX), whose last four digits pick what a call
  does (`0001` answers, `0004` is never answered, `0005` is busy), so no test
  can ring a real phone. Readiness passes through `sandbox_only` (false unless
  Drop Cowboy says exactly `true`; `server/CONTRACT.md`, both servers and
  conformance suite 03). When it is on, the Setup page and the contact page
  say the team can reach test numbers only, in both front-ends; new guidance
  for the `sandbox_only` and `sandbox_concurrency` refusals. New
  `shared/sandbox.js` and `tests/e2e/specs/sandbox.spec.js`, whose live-only
  specs call an answering and a busy test number and wait for the automatic
  reply to a text through the webhook.
- **Vercel.** `server/nextjs` runs the Node server core behind Next.js App Router
  route handlers, with both front-ends, and ships a Deploy with Vercel button
  (Neon Postgres, optional Upstash Redis). Two webhook modes need no worker:
  `DC_WEBHOOKS=vercel-queue` (Vercel Queues, the default on Vercel) and
  `qstash` (Upstash QStash; the Python server supports this one too). A daily
  Vercel Cron calls `/internal/maintenance` with `CRON_SECRET`. On a function
  host `DC_ENV` defaults to `production`, `DC_STORE` to `postgres` when a
  database address is set, and `DC_EVENTS_MAX_STREAM_SECONDS` to 290; a store,
  worker or fan-out that lives in one process is refused. Postgres migrations
  now take their lock inside one transaction (with a 60 second wait), because a
  session lock leaked through a pooled connection string and hung every later
  boot. New boot codes: `serverless_store`, `serverless_webhooks_store`,
  `serverless_worker`, `serverless_fanout`, `missing_qstash_setting`,
  `missing_qstash_public_url`, `invalid_qstash_public_url`,
  `insecure_qstash_public_url`, `invalid_qstash_url`, `vercel_queue_off_vercel`
  and `vercel_queue_node_only`. New test stages `lint:nextjs`, `nextjs:build`,
  `conformance:nextjs` and `e2e:nextjs:{vanilla,react}`. Documented in
  `HOSTING.md`, `server/CONTRACT.md`, `docs/providers/webhooks.md` and
  `docs/providers/fanout.md`.
- **Netlify.** `server/netlify` serves both front-ends from Netlify's CDN, with a
  `_headers` file built from the server's own configuration, and runs the Node
  server core in Netlify Functions; `netlify.toml` and a Deploy to Netlify button
  set it up. `DC_WEBHOOKS=netlify-async`, the default on Netlify, sends each event
  id to Netlify Async Workloads, whose workload function runs the handlers and
  retries them on the processor's backoff; `qstash` is the tested fallback, and
  the Python server refuses the mode. A daily scheduled function runs maintenance.
  `NETLIFY_DB_URL` (Netlify Database) is read after `DC_DATABASE_URL` and
  `DATABASE_URL`. On Netlify `DC_EVENTS_MAX_STREAM_SECONDS` defaults to 25 and
  the stream sends a keepalive every 5 seconds, because Netlify cut streams at 30
  seconds and dropped a write after about 10 seconds of silence. New boot codes:
  `netlify_async_off_netlify`, `missing_awl_api_key` and `netlify_async_node_only`.
  New test stages `netlify`, `lint:netlify`, `netlify:build`,
  `conformance:netlify` and `e2e:netlify:{vanilla,react}`. `npm run test:deployed`
  accepts the request id and the `Cache-Control` spacing a CDN sends, tells a cold
  start from a slow webhook, and can record video (`PLAYWRIGHT_VIDEO=on`).
  Documented in `HOSTING.md`, `server/netlify/README.md`, `server/CONTRACT.md`,
  `docs/providers/webhooks.md` and `TROUBLESHOOTING.md`.
- **AWS.** `DC_STORE=dynamodb` and `DC_DATA=dynamodb` keep events and module
  documents in one DynamoDB table, `DC_WEBHOOKS=sqs` queues event ids on Amazon
  SQS (at least once, with backoff through the visibility timeout), and
  `DC_SECRETS=aws-secrets-manager` and `aws-ssm` read secrets with the task role.
  Node and Python read each other's data. `DC_REDIS_CLUSTER=on` connects the
  Redis store, fan-out, rate limit and BullMQ through a cluster client (BullMQ
  on the Python server is not supported on a cluster). `deploy/aws/ecs-express.yaml`
  is a plain CloudFormation template for Amazon ECS Express Mode, driven by
  `npm run deploy:aws` and `npm run destroy:aws`. New boot codes:
  `missing_aws_region`, `invalid_aws_endpoint`, `insecure_aws_endpoint`,
  `invalid_dynamodb_table`, `missing_sqs_queue_url`, `invalid_sqs_queue_url`,
  `insecure_sqs_queue_url`, `missing_aws_secret_id`, `missing_aws_ssm_path`,
  `invalid_aws_ssm_path`, `invalid_redis_cluster` and `bullmq_cluster_unsupported`.
  Documented in `HOSTING.md`, `server/CONTRACT.md` and `docs/providers/`.
- **Modules, module data and Deals.** Your own screens with their own data:
  routes under `/api/modules/<id>` on both servers, a data API with per-user
  isolation (`DC_DATA`: `memory`, `sqlite`, `postgres` or your own, migration
  `002_module_data`), input validation from one JSON schema file both servers
  read (`400 invalid_request`, `415 unsupported_media_type`), and Deals as the
  worked example with a page in both front-ends. A `contact.deleted` event
  archives that contact's deals. `npm run new:module -- <id>` makes a new module.
  CSRF checks now cover `DELETE` as well as `POST`. `DC_STORE=redis` in server
  mode needs `DC_DATA` set (`data_provider_required`). Documented in
  `CUSTOMIZE.md`, `docs/providers/data.md` and `server/CONTRACT.md`.
- **Identity providers.** `DC_IDENTITY` is now `dev` (default, local only),
  `passcode`, `oidc` or a path to your own provider. `passcode` signs in with
  one shared passcode and a signed, HttpOnly, 12-hour cookie. `oidc` verifies a
  bearer JWT (RS256 or ES256) from Auth0, Clerk, Supabase, Firebase or any
  OpenID Connect issuer. New routes `GET /api/auth/session`,
  `POST /api/auth/passcode` and `POST /api/auth/signout`.
- **Provider framework** for identity, secrets (`env`, `file`), rate limits
  (`memory`, `off`), logs (`console`) and observers, chosen by `DC_IDENTITY`,
  `DC_SECRETS`, `DC_RATE_LIMIT`, `DC_LOG` and `DC_OBSERVER`, on both servers.
  `npm run conformance:provider -- <kind> <path-or-built-in>` and
  `python -m starter_crm.provider_check <kind> <path>` check your own.
  Documented in `docs/providers/`.
- **Front-end sign-in.** A passcode form in both the vanilla and React
  front-ends, a Sign out button, and `setAuthHeaderProvider()` in
  `shared/server-api.js` for bearer tokens. The live event stream uses a
  fetch-based reader when a header provider is set, because `EventSource`
  cannot send headers.
- **Security.** Response headers and a Content-Security-Policy (`DC_CSP`),
  CORS allowlist (`DC_CORS_ORIGINS`), CSRF origin checks on cookie-authenticated
  `POST`s (`403 csrf_rejected`), and rate limits with `Retry-After`
  (`429 rate_limited`).
- **Calling Drop Cowboy carefully.** Per-user site token reuse
  (`DC_TOKEN_CACHE`), bounded retries of idempotent upstream reads, and
  `Retry-After` pass-through.
- **Observability.** `X-Request-Id` on every response and in every error body
  and log line, JSON logs in production, access lines (`DC_LOG_REQUESTS`),
  mandatory redaction of secrets, tokens, phone numbers and email addresses,
  and observer hooks (`onRequest`, `onResponse`, `onError`, `onWebhook`,
  `onTokenMinted`).
- **Secrets from files.** `DC_SECRETS=file` reads Docker and Compose
  secret files and refreshes them without a restart.
- **Containers.** A `Dockerfile` for the Node server and
  `server/python/Dockerfile` for the Python one: multi-stage, digest-pinned
  base images, user 1000, `HEALTHCHECK`, `DC_ENV=production`, no Building Blocks
  code. `compose.yaml` runs either with secrets mounted from `./secrets` and read
  by `DC_SECRETS=file`. The Python image runs Gunicorn with one worker and drains
  event streams on SIGTERM, and writes no access log. `.devcontainer/` for
  Codespaces. `npm run test:container` builds both images, runs the server
  contract suite against a container of each, then smoke and image-contents
  checks.
- **Hosting and releases.** `HOSTING.md` and `UPGRADING.md`, and `.github/workflows/images.yml`: lint,
  container tests and a grype scan that fails on any fixable high or critical
  finding, then on a version tag a push to GitHub Container Registry with an
  SBOM and a signed build-provenance attestation.
- **`npm run test:deployed -- --url https://...`** checks a running host: HTTPS,
  headers, caching and gzip, `/healthz` and `/readyz`, a webhook acknowledged in
  under a second, an event stream that stays open past the host's idle limit, and
  a browser sign-in in both front-ends.
- **Front-end delivery.** Hashed React assets are `immutable`, other files are
  `no-cache` with an `ETag` and `304`, and text files of 1 KB or more are
  gzipped.
- **Secret managers.** `DC_SECRETS` now also accepts `doppler`, `infisical`,
  `vault` (HashiCorp Vault and OpenBao, KV v2, token or AppRole) and `1password`
  (service account). They load at boot, refresh without a restart, keep the last
  good values when the manager is down, require `https` except for loopback,
  refuse redirects, and never print a value or a credential. Tested against
  stand-ins on both servers and against a real OpenBao.
  `docs/providers/secrets.md` has the settings and the 1Password layouts.
- Dependencies `@1password/sdk` (Node) and `onepassword-sdk` (Python), loaded
  only by the `1password` provider.
- `SUITE=<regex>` limits `server/conformance/run.js` to matching suite files.
- `tests/services.compose.yml` starts an OpenBao for the conformance suite.
- `CUSTOMIZE.md` with recipes for each sign-in service, a custom identity,
  Sentry and OpenTelemetry.
- New boot problem codes, listed in `TROUBLESHOOTING.md`.
- Dependencies `jose` (Node) and `PyJWT` (Python), loaded only by `oidc`.
- **Durable events.** Every verified webhook is written to an event store
  (`DC_STORE`: `memory`, `sqlite`, `postgres`, `redis` or your own) before the
  `200`, so a restart or crash loses nothing. Both servers share the same SQL
  migrations (`server/migrations`), run at boot under a lock.
- **Many instances.** A fan-out (`DC_FANOUT`: `local`, `poll`, `redis`,
  `postgres`) carries each finished event to the streams on every instance, and
  `GET /api/events` replays from the store after a reconnect or restart.
  `DC_RATE_LIMIT=redis` shares the rate limit.
- **Webhook handlers.** `DC_WEBHOOKS` runs your `DC_WEBHOOK_HANDLERS` from the
  store (`store`), a BullMQ queue (`bullmq`, which a Node and a Python server can
  share) or inside the request (`inline`). A slow handler never delays the `200`;
  failures retry with backoff and then show as `failed`. `npm run worker` runs
  handlers in their own process, and `npm run webhooks:failed` and
  `webhooks:replay` list and re-run failures.
- **Retention and erasure.** Events are deleted `DC_EVENT_RETENTION_HOURS` after
  they finish. A `contact.deleted` event removes that contact's other events.
- **`GET /api/webhooks/status`**, a Setup page item and `npm run doctor` checks
  for handler health and for a registered webhook.
- Compose profiles `redis` and `python-redis` (Valkey with AOF and `noeviction`,
  plus a worker); `npm run soak` and a weekly workflow; `npm run migrate:status`.
- Boot refuses plain-text Redis and Postgres hosts that are not local in
  production (`insecure_redis_url`, `insecure_database_url`), unless
  `DC_INSECURE_PRIVATE_SERVICES=on`.
- Dependencies `bullmq`, `ioredis` and `pg` (Node) and `redis`, `bullmq`,
  `psycopg` and `psycopg-pool` (Python), loaded only by the stores and queues that use them.

### Changed

- Building Blocks 3.33.16 is the default `DC_CDN_VERSION`. Calls placed
  from the Dock now play the other party's audio; before, they connected in
  silence. A call starts ringing within about a second of clicking Call; in
  Chrome on a computer with a VPN or virtual machine network it used to sit
  on Dialing for about 40 seconds first. The Dock signs its phone in when the
  phone pane opens, so the first call no longer waits for that. Done on the after-call screen
  returns the phone to the keypad. The Dock's phone has an Audio settings icon for choosing the
  microphone and speaker and testing the microphone. This browser remembers
  the choice, and it can be changed during a call. A call shows Connected when the far end picks up, instead of showing
  Ringing for up to 8 seconds after it. A call's
  `disposition` in the Activity feed is now how the far end ended it
  (`completed`, `busy`, `no_answer`, `rejected`, `no_service`, `failed`, or
  `hung_up` when you ended it) instead of `Terminated`, and a call nobody
  picked up reports a duration of 0. A call's duration starts when the far
  end picks up, so ring time is no longer counted. A call Drop Cowboy
  refuses, such as a sixth test call (`sandbox_concurrency`), reports
  `rejected`. The Phone page's loading skeletons are announced to screen
  readers.
- `requireUser()` and `require_user()` now ask the chosen identity who is
  calling, instead of returning `STARTER_CRM_USER_ID` for everyone.
  `STARTER_CRM_USER_ID` now only names the `dev` user, or optionally the one
  `passcode` user.
- The Node server is built from web-standard handlers (`Request` in,
  `Response` out) with Express as a thin adapter.
- `PRODUCTION.md` replaces "replace `requireUser()`" with choosing an identity.
- The default `DC_RATE_LIMIT` is `redis` when `DC_REDIS_URL` is set.
- Compose runs the Node and Python servers on SQLite on a volume instead of in
  memory, so events survive a restart.
- The Python dev server now exits on `SIGTERM` within the grace period; it used
  to hang until killed.
- The Python server's BullMQ worker now stops within the grace period. BullMQ for
  Python's own graceful close could wait indefinitely on an idle worker.

### Upgrading

- A deployment that relied on `DC_IDENTITY=dev` under `DC_ENV=production`
  already failed to boot (`production_dev_identity`); nothing changes.
- With the default `DC_STORE=memory` nothing changes. To keep events across a
  restart, set `DC_STORE`. If `DC_REDIS_URL` is already set for another purpose and
  `DC_STORE` is durable, webhooks now run through BullMQ by default, so Redis must use
  `maxmemory-policy noeviction`; set `DC_WEBHOOKS=store` to opt out.
- A custom `requireUser()` edit should move into an identity provider file.
  See `docs/providers/identity.md`.
