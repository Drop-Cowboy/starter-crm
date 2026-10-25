# Production checklist

The starter is safe to run on your own machine. Before real users touch it:

1. **Choose a real identity.** `DC_IDENTITY=dev` treats every visitor as one
   user, so `DC_ENV=production` refuses it. Set `DC_ENV=production` and then:
   - `passcode` for a private CRM: `DC_PASSCODE` of 12 or more characters, kept
     in your secret store. Everyone with it is the same user. Rotate it to sign
     everyone out.
   - `oidc` when your users already sign in elsewhere: `DC_OIDC_ISSUER`,
     `DC_OIDC_AUDIENCE`. Recipes for Auth0, Clerk, Supabase and Firebase are in
     [`CUSTOMIZE.md`](CUSTOMIZE.md).
   - `./my-identity.js` (or `.py`) for your own session system, checked with
     `npm run conformance:provider -- identity ./my-identity.js`.

   The identity guards the token route and `/api/events`, and its user id
   becomes the `sub` of every site token.
2. **Serve over HTTPS.** Run the server behind TLS, keep `HOST` on loopback
   behind your proxy, set `DC_TRUST_PROXY=1` (or the hop count your proxy
   needs), and set `DC_PUBLIC_URL` to the public origin Drop Cowboy and
   browsers use. Give Drop Cowboy that origin's `/webhooks/dropcowboy` URL.
3. **Keep secrets in a secret store.** Load the API key, API secret, webhook
   secrets and passcode from your platform's secret manager, not a `.env` file
   on disk. `DC_SECRETS=file` with `DC_SECRETS_DIR=/run/secrets` reads Docker,
   Compose secret files, and a running server picks up rotated
   values after `DC_SECRETS_REFRESH_SECONDS` (not `DC_PASSCODE`). For Doppler,
   Infisical, Vault or OpenBao, or 1Password, choose the built-in
   [secrets provider](docs/providers/secrets.md); for anything else write one. The server redacts
   every loaded secret, site and access token, phone number and email address
   from its logs; do not add log lines of your own that print them.
4. **Make webhooks durable.** List the signing secret of every webhook in
   `DROPCOWBOY_WEBHOOK_SECRET`. Rotating a secret stops the old one at once, so
   add the new one right away. Set `DC_STORE` to `sqlite` (one machine),
   `postgres` or `redis`, never `memory`: the server then writes each event to
   the store before it answers, skips an `X-Event-Id` it already has, and runs
   your handlers from `DC_WEBHOOK_HANDLERS` after the `200`, retrying a failure
   with backoff. Handlers run at least once, so key your work on the event id.
   Look at **Webhook handling** on the Setup page (or `npm run doctor`): failed
   events are listed by `npm run webhooks:failed` and re-run with
   `npm run webhooks:replay`.
5. **Check the rate limits fit your setup.** The server limits the token
   route (300 a minute per IP, and 30 a minute per user that reach Drop
   Cowboy), passcode sign-in (10 a minute per IP) and the dev session route.
   `DC_RATE_LIMIT=memory` counts per process, so with several instances or a
   serverless host each counts alone. Set `DC_REDIS_URL` and the limit moves to
   Redis by itself (`DC_RATE_LIMIT=redis`), shared by every instance; or write a
   [rate-limit provider](docs/providers/ratelimit.md) over your database. Set `DC_TRUST_PROXY` behind a proxy, or every user shares the
   proxy's IP. A site token is reused until a minute before it expires
   (`DC_TOKEN_CACHE=on`), so page loads do not mint every time.
6. **Pin the CDN and enforce the Content Security Policy.** Set
   `DC_CDN_VERSION` to the release you tested. For the strongest protection,
   copy that release's `integrity` values into your build instead of fetching
   the manifest at runtime. The server sends a policy for the pages it serves,
   in report-only mode by default (`DC_CSP=report-only`). Watch the browser
   console on every page, including a call, a text and the Setup page, then set
   `DC_CSP=enforce`. If you load the front-end from another site, list that
   origin in `DC_CORS_ORIGINS` (exact origins, never `*`); a cross-origin
   front-end sends `Authorization`, never cookies.
7. **Keep the phone token on the phone page.** It can rent numbers. Leave
   `window.DropCowboy.confirmSpend = true` set before any bundle loads.
8. **Use Gunicorn for Python in production.** Prefer
   `gunicorn -c gunicorn.conf.py starter_crm.wsgi:app` from `server/python/`
   over `python -m starter_crm`. The conf file wires the same SIGTERM drain
   as the Node server. It runs one worker with eight threads. Each open live
   stream holds a thread, so set `GUNICORN_THREADS` to your expected open
   streams plus a margin. Raise `WEB_CONCURRENCY` only with a shared store
   (`postgres`, `redis`) and a fan-out that reaches every worker. It writes no access log, since Gunicorn's logs the whole
   request line and a site token can be in an event-stream query string. The
   container image does all of this for you.
9. **Set `DC_SHUTDOWN_GRACE_SECONDS`.** Default is 10. On SIGTERM the server
   stops accepting connections, `/readyz` returns `503`, open SSE streams get
   `retry: 1000` and close, then the process exits within the grace period.
10. **Probe `/healthz` and `/readyz`.** `/healthz` is cheap liveness.
    `/readyz` is readiness (event store, fan-out and webhook queue ready, not draining). Point load balancers
    at `/readyz` so they stop traffic before shutdown. The account checklist
    stays at `GET /api/dropcowboy/readiness`.
11. **Check the host, not just the code.** [`HOSTING.md`](HOSTING.md) covers
    containers. Keep one instance awake (Drop Cowboy waits 5 seconds
    for a webhook), pin an image tag such as `:1.2.3` instead of `:latest`, and
    run `npm run test:deployed -- --url https://your-host` after every change
    to the host: it proves HTTPS, the headers, a webhook acknowledged in under
    a second and an event stream that outlives the host's idle limit.
12. **Back up the event store, and encrypt its connection.** Events are kept
    `DC_EVENT_RETENTION_HOURS` (default 72) after they finish, so a backup is
    about recovering a failed day, not history. Use your host's own backup:
    managed Postgres point-in-time recovery, a snapshot of the volume holding
    `DC_SQLITE_PATH` (copy it with `sqlite3 .backup`, never while writing with
    `cp`), a DynamoDB table with point-in-time recovery (the AWS template turns it
    on), or Redis with AOF on and `maxmemory-policy noeviction`. With
    `DC_ENV=production` the server refuses a Postgres or Redis URL that is not
    TLS (`rediss://`, `sslmode=require`) unless the host is local or you set
    `DC_INSECURE_PRIVATE_SERVICES=on` for a private network you control.
    Your modules' records (`DC_DATA`) are the thing you cannot rebuild: they live
    in the same database as the events when `DC_STORE` is `sqlite`, `postgres` or
    `dynamodb`, so one backup covers both, and with `DC_STORE=redis` they are in the
    `DC_DATA` database, which needs its own. Unlike events they never expire.
    Migrations run at boot under a lock; check them with `npm run migrate:status`.
    SQLite runs in WAL mode with `synchronous = NORMAL`, so a write does not wait
    for the disk to flush. A crash or restart of the server or its container
    loses nothing. A power cut or operating-system crash can lose the most
    recent writes, those since SQLite last flushed its log, including webhooks
    already answered with `200`, which Drop Cowboy then will not send again.
    If that matters to you, use Postgres. Waiting for a flush on every write
    froze the Node server for seconds at a time on a slow cloud disk.
13. **On Vercel, check the function settings.** [`HOSTING.md`](HOSTING.md) has the
    steps. In production: turn Deployment Protection off for the domain (it
    blocks the webhook and the queue), set `CRON_SECRET`, use a pooled Postgres
    address and Upstash Redis if you run more than one instance, and keep
    `DC_WEBHOOKS` on `vercel-queue` or `qstash` (a handler never runs between
    requests). The server refuses to boot with a store, worker or fan-out that
    would lose events there (`serverless_*`).
14. **On Netlify, check the site settings.** [`HOSTING.md`](HOSTING.md) has the
    steps. In production: create the Netlify Database (or set `DC_DATABASE_URL`),
    install Async Workloads and, on a Starter team, create the site's
    `AWL_API_KEY`, add Upstash Redis if you run more than a few instances, and keep
    `DC_WEBHOOKS` on `netlify-async` or `qstash`. Check the deploy log lists
    `async-workloads-router`; without it every webhook answers `503`. The same
    `serverless_*` refusals apply.

## Your responsibilities

These match the complementary controls Drop Cowboy expects of you as the
customer running this sample:

- Keep the API secret on the server only. Rotate it if it leaks.
- Require MFA at your identity provider, and limit who can sign in.
- Serve the app over HTTPS with a current certificate.
- Patch dependencies (npm and pip) on a regular cadence; Dependabot is wired
  in the template repo.
- Keep the server clock NTP-synced. Webhook timestamps allow 300 s of drift;
  OIDC allows 60 s.
- Hosted databases encrypt at rest; a SQLite file does not unless the disk
  does. Prefer a hosted store once you leave single-instance demos. Events
  hold contact details, so retention (`DC_EVENT_RETENTION_HOURS`) is part of
  your data policy: a `contact.deleted` event erases that contact's events.
- Multi-user access in this sample is one role by design. To add roles, return
  them from your own identity provider and mint tokens with the least scope
  each role needs.

## What this sample does not claim

This sample makes **no compliance claims**. It is not "SOC 2 compliant" or
"HIPAA compliant". Drop Cowboy's own SOC 2 Type I covers Drop Cowboy's
service, not code you run. A BAA, if you have one, covers Drop Cowboy, not
your hosting of this starter.

## What to alert on

Set `DC_LOG_FORMAT=json` (the default when `DC_ENV=production`) and
`DC_LOG_REQUESTS=on` so a log service can alert on these. Every line carries a
`request_id`, the same value as the `X-Request-Id` response header and the
error body, so a user's report leads straight to the lines. Send errors to
your tracker with an [observer](docs/providers/observer.md); `CUSTOMIZE.md` has
Sentry and OpenTelemetry recipes.

- Mint failures (`POST /api/dropcowboy/token` 5xx or upstream errors)
- Sign-in failures: a burst of `401 invalid_passcode`, or `429 rate_limited`, on
  `/api/auth/passcode`
- `503 identity_unavailable`, meaning your sign-in provider's keys are unreachable
- `403 csrf_rejected`, which is a misconfigured origin or an attack
- Webhook signature rejections
- Outbox depth and age: `received` and `oldest_received_age_seconds` from
  `GET /api/webhooks/status`. An age above a few minutes means no worker is
  running or the handlers are stuck.
- Handler failures: `failed` from the same route above zero, and `Handler failed`
  log lines. The Setup page shows them as a to-do.
- SSE connection count, and for Python the `GUNICORN_THREADS` it must stay under
- 5xx rate on your origin
- `/readyz` flipping to not-ready outside a deploy

## Load behavior we measured

A weekly soak (`npm run soak`, `.github/workflows/soak.yml`) posts 50
webhooks a second for 10 minutes to a server holding open live streams, on a
four-CPU GitHub runner. It passes when every webhook is acknowledged within a
second at p99, every stream receives every event, and memory stays flat.

- **Node** holds 500 streams on one process, with either sqlite or Postgres,
  Redis and BullMQ.
- **Python with Postgres and Redis** holds 500 streams with four Gunicorn
  workers (`WEB_CONCURRENCY=4`). One Python process runs one thread at a time,
  so a single worker falls behind at this load. Run one worker per CPU, which
  is safe because the Redis fan-out reaches every worker.
- **Python with sqlite** holds 200 streams on one process. The soak uses the
  local fan-out (`DC_FANOUT=local`), which only reaches streams in its own
  process, so it cannot add workers. For more, use the Node server or move to
  Postgres and Redis.

To check your own numbers, run `npm run soak -- --server python --profile
postgres-redis --workers 4 --streams 800` against your setup first.

## Reporting a security problem

Don't open a public issue. Follow the
[security policy](https://github.com/Drop-Cowboy/starter-crm/security/policy)
instead.
