# Hosting the Starter CRM

This page puts your CRM on the internet, so your team can use it and Drop
Cowboy can send it webhooks. When you're done you'll have a public address
with sign-in, live activity, and a check that says it all works.

## Which host should I pick?

- **Built it in Bolt or a similar tool, or want the fewest steps?** Use
  [Netlify](#netlify).
- **Already on Vercel, or using Next.js?** Use [Vercel](#vercel).
- **Have a server, a VPS, or any host that runs containers?** Use
  [Docker](#docker-and-compose).
- **Your team runs on AWS?** Use [AWS ECS Express](#aws-ecs-express).

Not sure? Pick Netlify. You can move later: your contacts, conversations and
call history live in Drop Cowboy, not on the host. Only your own modules'
data, such as deals, lives with the server; see [A database](#a-database).

## What you'll need

- Your copy of the starter, working on your computer with `npm start`.
- Your Drop Cowboy API key and secret.
- A passcode for your team to sign in, 12 characters or more. Or your own
  sign-in provider; see [`CUSTOMIZE.md`](CUSTOMIZE.md#choose-who-signs-in).
- An account with the host.

After the first deploy, [create a webhook](docs/webhooks.md) that points at
your new address, and go through the [production checklist](PRODUCTION.md)
before real users sign in.

## All the hosts

Any host that runs a container works with the `Dockerfile` (Node) or
`server/python/Dockerfile` (Python). These are the ones we test and
document, each the best fit for one kind of user.

| Host | For | How you deploy | Ready |
|---|---|---|---|
| Local | Development | `npm start` or `npm run dev` | Yes |
| Docker or Compose | Any container host, or a VPS, and the way to run production today | `docker compose up --build` | Yes |
| AWS ECS Express | Teams already on AWS | `npm run deploy:aws` | Yes |
| Vercel | Next.js teams | A deploy button, or `vercel deploy` | Yes (Vercel Queues is a public beta; `qstash` is the fallback) |
| Netlify | Projects built in Bolt and similar tools | A deploy button, or `netlify deploy` | Yes (Node only; `qstash` is the fallback to Async Workloads) |

Every host needs the same few settings. Where they go differs, and nothing
secret belongs in a file you commit.

| Setting | What it is |
|---|---|
| `DROPCOWBOY_SITE_ID` | One stable UUID for this app. Copy the one in your `.env` to keep the inbox you've been using; otherwise generate one (`node -e "console.log(crypto.randomUUID())"`) and keep it, because a new one starts an empty inbox. |
| `DROPCOWBOY_API_KEY`, `DROPCOWBOY_API_SECRET` | From **Developers > API keys**. Secret. |
| `DC_IDENTITY`, `DC_PASSCODE` | `passcode` with a passcode of 12 or more characters, or `oidc` ([`CUSTOMIZE.md`](CUSTOMIZE.md)). The image runs with `DC_ENV=production`, which refuses the local-only `dev` identity. Secret. |
| `DROPCOWBOY_WEBHOOK_SECRET` | The signing secret of the webhook you create in Drop Cowboy. It does not exist until the webhook does, so add it after the first deploy. Secret. |
| `DC_PUBLIC_URL` | The public address of the app. The server logs "Point Drop Cowboy webhooks at ..." from it. |
| `DC_TRUST_PROXY` | `1` behind one proxy or load balancer. |

The webhook URL you give Drop Cowboy is your public address plus
`/webhooks/dropcowboy`. Webhooks must be acknowledged within 5 seconds, so the
host must keep one instance awake. A host that sleeps when idle will lose
events.

## Docker and Compose

```sh
npm run setup -- --yes      # only if there is no .env yet: it writes the site id
mkdir -p secrets && chmod 700 secrets
printf '%s' "$KEY"    > secrets/DROPCOWBOY_API_KEY
printf '%s' "$SECRET" > secrets/DROPCOWBOY_API_SECRET
printf '%s' "$PASS"   > secrets/DC_PASSCODE
printf '%s' "$HOOK"   > secrets/DROPCOWBOY_WEBHOOK_SECRET   # empty until the webhook exists
chmod 600 secrets/*
DC_IDENTITY=passcode docker compose up --build
```

For the Python server instead, run
`DC_IDENTITY=passcode docker compose --profile python up --build starter-crm-python`.
Run one server at a time: the Node and Python services share port 8080.

**Why `DC_IDENTITY=passcode` in front.** The image runs in production, which
refuses the local-only `dev` identity. `npm run setup` writes `DC_IDENTITY=dev`
to `.env` so that `npm start` works on your computer, and Compose would pass it
to the container. A value in your shell wins over `.env`, so the command above
keeps both working. For your own sign-in provider, use `DC_IDENTITY=oidc` with
`DC_OIDC_ISSUER` and `DC_OIDC_AUDIENCE` set the same way.

[`compose.yaml`](compose.yaml) mounts each file in `./secrets` at
`/run/secrets` and the server reads them with `DC_SECRETS=file`, so the secrets
never enter the container's environment or `docker inspect`. Compose reads your
shell and `.env` only to fill the settings listed under `environment:` in
`compose.yaml`; to pass another one, add a line there. The container runs as
user 1000 with a read-only filesystem and no capabilities; on Linux, a secret
file must be readable by user 1000. The port is published on `127.0.0.1` only,
so put a TLS proxy in front (Caddy, Traefik, nginx) and set `DC_PUBLIC_URL` and
`DC_TRUST_PROXY=1`.

### Your own files in the image

The images copy only the folders listed in `.dockerignore`: `shared`,
`vanilla`, `react` and `server`. Modules made with `npm run new:module`, and
changes to the front-ends, are inside those and need nothing more.

A file you keep at the starter root, such as `./my-identity.js`,
`./my-observer.js` or `./my-handlers.js` from [`CUSTOMIZE.md`](CUSTOMIZE.md),
is **not** in the image, and the server refuses to start without it. Either
move it into `server/node/src/` (or `server/python/starter_crm/` for a `.py`
file) and point the setting at the new path, such as
`DC_IDENTITY=./server/node/src/my-identity.js`; or allow it in `.dockerignore`
(`!my-identity.js`) and copy it in the `Dockerfile`
(`COPY --chown=node:node my-identity.js ./`; in `server/python/Dockerfile`,
`COPY --chown=starter:starter my_identity.py ./`). A package your file imports, such as
`@sentry/node`, must be installed in `server/node` so the image has it.

### The Python image

The Python image runs Gunicorn with **one worker and eight threads**
(`GUNICORN_THREADS`). Every open live stream holds one thread for as long as the
browser stays connected, so a worker serves at most `WEB_CONCURRENCY` x
`GUNICORN_THREADS` streams and other requests wait once they are used. Set the
threads to your expected open streams plus a margin. Raise `WEB_CONCURRENCY`
only with a shared event store (`postgres`, `redis`, or `sqlite` on one
machine) and a fan-out that reaches every worker. Python threads share one
interpreter lock, so a Python server delivers a burst of events to hundreds of
streams more slowly than the Node server does. "Load behavior we measured" in
`PRODUCTION.md` gives the stream counts each setup holds. It writes no access
log, because Gunicorn's logs the raw request line and a site token can sit in
the query string of the event stream.

### Secret managers

On any host, `DC_SECRETS` can read from Doppler, Infisical, Vault or OpenBao,
or 1Password instead of files or variables. See
[`docs/providers/secrets.md`](docs/providers/secrets.md).

## AWS ECS Express

Amazon ECS Express Mode runs one container behind a load balancer, with HTTPS, a
public address and autoscaling, from one resource. `deploy/aws/ecs-express.yaml`
is a plain CloudFormation template (no CDK, no SAM, no transform) that adds what
the CRM needs around it: a DynamoDB table (events and module data), an SQS queue
with a dead-letter queue (webhooks), a Secrets Manager secret, least-privilege
roles, a log group, and optionally an ElastiCache Serverless (Valkey) cache for
live updates and shared rate limits.

```sh
npm run deploy:aws -- --region us-east-1 --image ghcr.io/<owner>/starter-crm:1.2.3
```

It needs the AWS CLI signed in to the account, and an image ECS can pull
(a tagged release from GitHub Container Registry works; a private ECR image needs
the execution role to read it). With no `--vpc-id` it uses your default VPC and
its subnets. It asks for the Drop Cowboy API key and secret and the passcode
without echoing them (or reads `DROPCOWBOY_API_KEY`, `DROPCOWBOY_API_SECRET`,
`DC_PASSCODE` and `DROPCOWBOY_WEBHOOK_SECRET` from the environment), creates the
stack, waits, and prints the app address and the webhook URL. Secrets go to the
AWS CLI in a temporary file that is deleted afterwards, never on a command line.

1. Run it. The first deploy takes about ten minutes (longer with `--redis true`).
2. In Drop Cowboy, create a webhook that points at the printed **Webhook URL**.
3. Run it again with `DROPCOWBOY_WEBHOOK_SECRET` set to the webhook's signing
   secret. Anything you do not name keeps its previous value, including the site
   id, so a second run only changes what you ask.
4. `npm run test:deployed -- --url <the App address>`.

Run `npm run deploy:aws -- --dry-run` first to see what it would do; it makes no
AWS call. `npm run destroy:aws` deletes the stack after you type its name. The
DynamoDB table is **retained** by default (`--retain-data true`), because it
holds your modules' records; delete it yourself when you are done. The secret
stays recoverable for Secrets Manager's recovery window.

Choices: `--webhook-mode sqs` (default) or `store`; `--secrets-mode inject`
(default, ECS hands the values to the container) or `runtime` (the app reads
Secrets Manager itself and sees rotations); `--redis true` adds the cache and
turns on `DC_REDIS_CLUSTER`; `--identity oidc` with `--oidc-issuer` and
`--oidc-audience`. Leave `--auth-mode` at `server`: `login` is reserved for
"Sign in with Drop Cowboy", which isn't available yet, and a stack deployed with
it has no way to sign in.
Use `--stack-name` for a second copy in the same account; nothing in the template
has a fixed name, and every resource is tagged `starter-crm:site-id` and
`starter-crm:stack`.

Things to know about Express Mode:

- **The load balancer is shared.** Express Mode puts up to 25 services in one VPC
  behind one load balancer, and whether it is internet-facing or internal is
  fixed by the first service that created it. A VPC that already has one for a
  private service will give this app a private address.
- Services run in your account's `default` ECS cluster.
- The service is scaled by CPU between one task and `--max-tasks`. The Python
  image's note about open streams per worker (above) applies to each task.
- The template cannot be tested without an AWS account, so the checks that run in
  CI are `cfn-lint` and tests that compare the table with the one the servers
  expect. Treat your first deploy as a sandbox: run `test:deployed` against it.

**Your own tooling.** Terraform, CDK or the console work too: create a DynamoDB
table with the layout in [`server/CONTRACT.md`](server/CONTRACT.md) ("DynamoDB")
and set `DC_STORE=dynamodb`, `AWS_REGION` and `DC_DYNAMODB_TABLE`. The task role
needs only the DynamoDB actions listed in the template, `sqs:SendMessage`,
`ReceiveMessage`, `DeleteMessage`, `ChangeMessageVisibility` and
`GetQueueAttributes` on the queue, and `secretsmanager:GetSecretValue` on the
secret in runtime mode.

## Vercel

The Next.js variant in [`server/nextjs`](server/nextjs) runs the same server core
behind App Router route handlers, with the same two front-ends. It is a function
host, so it differs from the container hosts in three ways: there is no process
between requests, so handlers run when a **queue** calls the app back
(`DC_WEBHOOKS=vercel-queue`, or `qstash`); events live in **Postgres** (Neon) and
reach browsers through the database or Redis (Upstash); and a live event stream
ends after 290 seconds and the browser reconnects, without losing events.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FDrop-Cowboy%2Fstarter-crm&root-directory=server%2Fnextjs&project-name=starter-crm&repository-name=starter-crm&env=DROPCOWBOY_SITE_ID%2CDROPCOWBOY_API_KEY%2CDROPCOWBOY_API_SECRET%2CDC_PASSCODE%2CDC_IDENTITY&envDescription=Your%20Drop%20Cowboy%20API%20key%20and%20secret%2C%20a%20site%20id%20(any%20UUID)%2C%20a%20passcode%20of%2012%20or%20more%20characters%2C%20and%20DC_IDENTITY%20set%20to%20passcode&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%7D%5D)

The button makes a fresh copy of the template, sets the project's root
directory to `server/nextjs`, and asks for `DROPCOWBOY_SITE_ID` (copy it from
your `.env` to keep your inbox), `DROPCOWBOY_API_KEY`, `DROPCOWBOY_API_SECRET`,
`DC_PASSCODE` and `DC_IDENTITY` (type `passcode`). Its Neon step creates a
Postgres database and sets `DATABASE_URL`, which the server reads when
`DC_DATABASE_URL` is empty.

**To deploy your own copy** with your changes, don't use the button: in Vercel
choose **Add New > Project**, import your repository, set **Root Directory** to
`server/nextjs`, add the same five settings, and add Neon from the Storage tab.

Then:

1. `DC_IDENTITY` is `passcode`, or `oidc` for your own sign-in provider (see
   [`CUSTOMIZE.md`](CUSTOMIZE.md)). On Vercel `DC_ENV` defaults to
   `production` and `DC_STORE` to `postgres` once a database address is set, so
   neither needs setting. The server refuses to start on Vercel with a store that
   keeps events in one instance (`serverless_store`) and says so in the function log.
2. Set `CRON_SECRET` to a random value of 16 or more characters. Vercel Cron
   sends it to `/internal/maintenance` once a day, which publishes events whose
   message was lost and prunes old ones.
3. Deploy. In Drop Cowboy, create a webhook that points at
   `https://<your-domain>/webhooks/dropcowboy`.
4. Set `DROPCOWBOY_WEBHOOK_SECRET` to the webhook's signing secret and redeploy.
5. `npm run test:deployed -- --url https://<your-domain>`.

**Queues.** `vercel-queue` is the default and needs nothing to set: Vercel gives
the function a token for the queue, and `vercel.json` binds the topic
`starter-crm-webhook-jobs` to the consumer route. Vercel Queues is a public beta
and must be enabled for the team. If it is not, or you would rather not depend on
a beta, set `DC_WEBHOOKS=qstash` with `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`
and `QSTASH_NEXT_SIGNING_KEY` from Upstash's QStash page (the Vercel marketplace
integration sets all three). `DC_WEBHOOKS=inline` also works with handlers that
finish in about three seconds.

**Redis.** Add Upstash Redis from the marketplace and set `DC_REDIS_URL` to push
finished events to open streams at once and share rate limits across instances.
Without it, streams poll the database every second and each function instance
counts its own rate limits.

**Things to know.**

- **Deployment protection.** A project that has Vercel Authentication turned on
  answers every request, including the webhook and the queue, with a Vercel sign-in
  page. Turn it off for the production domain (Settings > Deployment Protection),
  or Drop Cowboy cannot reach `/webhooks/dropcowboy`.
- **Streams.** A function has a time limit (300 seconds on Hobby, up to 800 on
  Pro). `DC_EVENTS_MAX_STREAM_SECONDS` defaults to 290 there; the page reconnects
  and replays from `Last-Event-ID`. Streams use function time while open.
- **The pooled database address.** Neon's pooled address (`-pooler` in the host)
  cannot deliver `LISTEN`/`NOTIFY`, so a `postgres` fan-out falls back to `poll`
  with a notice. That is the default on Vercel. The pooled address is fine for
  everything else: migrations take their lock inside one transaction, which a
  connection pooler cannot split.
- **Local use.** `cd server/nextjs && npm run build && npm start` runs the same app
  as a long-running server (worker and maintenance loop included) on `HOST` and
  `PORT`, for trying it out and for the test suites. It does not use Vercel's queue.

## Netlify

The Netlify variant in [`server/netlify`](server/netlify) serves both front-ends
from Netlify's CDN and runs the same server core in Netlify Functions. Like
Vercel, it is a function host: handlers run when Netlify's **Async Workloads**
calls a workload function (`DC_WEBHOOKS=netlify-async`, or `qstash`), events live
in **Postgres** (Netlify Database), and a live event stream ends after 25 seconds
and the browser reconnects without losing events. It runs the Node server only.

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/Drop-Cowboy/starter-crm&fullConfiguration=true#DC_IDENTITY=passcode)

The button makes a fresh copy of the template, asks you to install the Async
Workloads extension for your team, and asks for `DROPCOWBOY_SITE_ID` (copy it
from your `.env` to keep your inbox), `DROPCOWBOY_API_KEY`,
`DROPCOWBOY_API_SECRET`, `DC_PASSCODE` (12 or more characters) and
`DC_IDENTITY`, already filled in as `passcode`. `netlify.toml` holds the build.

**To deploy your own copy** with your changes, don't use the button: in Netlify
choose **Add new project > Import an existing project**, pick your repository,
install the Async Workloads extension, and add those five settings under
**Project configuration > Environment variables**.

Then:

1. Create the database, where the server keeps events between requests (see
   [Postgres](docs/glossary.md)): in the project, **Data & Storage > Database >
   Create a database**. It sets `NETLIFY_DB_URL`, which the server reads when
   `DC_DATABASE_URL` and `DATABASE_URL` are empty, and gives each deploy preview
   its own branch of it. Netlify Database needs a credit-based plan; on another
   plan set `DC_DATABASE_URL` to any Postgres, such as Neon. Until there is one the
   server refuses to start (`serverless_store`) and says so in the function log.
2. On a **Starter** team, create the Async Workloads key: **Project
   configuration > Developer settings > Async Workloads > Create a new API key**,
   with any priority and a long random value. Netlify saves it as `AWL_API_KEY`.
   On other plans the extension creates one for the team when it is installed.
   Without it the server refuses to start (`missing_awl_api_key`).
3. Redeploy (**Deploys > Trigger deploy**). In Drop Cowboy, create a webhook that
   points at `https://<your-site>.netlify.app/webhooks/dropcowboy`.
4. Set `DROPCOWBOY_WEBHOOK_SECRET` to the webhook's signing secret and redeploy.
5. `npm run test:deployed -- --url https://<your-site>.netlify.app --hold-seconds 15`.
   The stream check holds for 75 seconds by default, which is longer than a
   Netlify stream lives.

On Netlify `DC_ENV` defaults to `production`, `DC_STORE` to `postgres` once a
database address is set, and `DC_WEBHOOKS` to `netlify-async`. A daily scheduled
function publishes events whose message was lost and prunes old ones; it needs no
secret, because Netlify does not let anyone call a scheduled function.

**Without Async Workloads.** Set `DC_WEBHOOKS=qstash` with `QSTASH_TOKEN`,
`QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` from Upstash's QStash
page. The server sends QStash the site's address (`URL`, which Netlify sets), or
`DC_PUBLIC_URL`. `DC_WEBHOOKS=inline` also works with handlers that finish in
about three seconds.

**Redis.** Set `DC_REDIS_URL` (Upstash) to push finished events to open streams at
once and share rate limits across instances. Without it, streams poll the
database every second and each function instance counts its own rate limits.

**Things to know.**

- **Streams.** Netlify documents 60 seconds for a streaming function, but streams
  measured on a Free-plan site in October 2026 were cut at 30 seconds, and a write
  that followed about 10 seconds of silence was lost and ended the stream. So on
  Netlify `DC_EVENTS_MAX_STREAM_SECONDS` defaults to 25 and the server sends a
  keepalive every 5 seconds. The page reconnects and replays from
  `Last-Event-ID`. Streams use function time while open.
- **Retries.** A handler that fails is retried by Async Workloads' scheduler,
  which runs every 60 seconds by default, so a 1-second backoff can take up to a
  minute. `AWL_SCHEDULER_INTERVAL` (10 to 900 seconds) changes that.
- **The first webhook after a quiet spell** boots the function and the Async
  Workloads router, and took about 2 seconds to acknowledge in October 2026
  instead of under one. That is inside Drop Cowboy's 5-second window. If the
  router does not accept the event within 3 seconds the webhook answers `503` and
  Drop Cowboy sends it again.
- **Revalidation.** Netlify's CDN tags a compressed file `"<tag>-df"` but only
  answers `304` to `"<tag>"`, so a browser downloads the page again on each load
  instead of revalidating it. Hashed React assets are cached for a year, so this
  costs the small HTML and the vanilla front-end's modules. A response the CDN
  has just revalidated also loses `Accept-Encoding` from its `Vary` header. The
  CDN still keeps the gzipped and plain copies apart, so only a cache in front of
  your visitors could mix them up.
- **The Async Workloads build fix.** The extension finds workload functions with
  `Dirent.path`, which Node 24 removed, and then silently skips its router, so
  every webhook answers `503`. `netlify.toml` sets `NODE_OPTIONS` for the build
  to put `path` back. A build that works lists `async-workloads-router` under
  `.netlify/functions-internal` in its log.
- **Deploying from the CLI.** Run `netlify deploy` from a copy where the starter is
  the repository root, as the button makes. Inside a larger repository the CLI
  treats that repository's root as the project, misses the functions it built and
  bundles them again without `included_files`, so the server cannot find its
  files.
- **Local use.** `npm start` in `server/netlify` runs the function on `HOST` and
  `PORT`, with the core serving the front-ends and running its worker as the Node
  server does, for the test suites. The CDN, `_headers`, Async Workloads and the
  schedule only exist on Netlify, so `npm run test:deployed` checks those.

## A database

The server keeps every webhook event in an **event store** (`DC_STORE`), so a
restart or a second instance loses nothing. The default is `memory`, which is for
trying the app. Pick the one that matches your host:

| Host | Store | Also set |
|---|---|---|
| One container or VPS | `sqlite`, the Compose default, on a volume | nothing |
| Several instances, or a managed database | `postgres` | `DC_DATABASE_URL` |
| Redis (Upstash, ElastiCache, Valkey) is all you have | `redis` | `DC_REDIS_URL`, persistence on, `maxmemory-policy noeviction` (`DC_REDIS_CLUSTER=on` for a cluster) |
| AWS, no SQL database | `dynamodb` | `AWS_REGION`, `DC_DYNAMODB_TABLE`. See "AWS ECS Express". |

With Redis available, queue and rate limit features turn on by themselves:
webhooks run through a BullMQ queue (`DC_WEBHOOKS=bullmq`), and the rate limit is
shared by every instance. Details are in [`docs/providers/store.md`](docs/providers/store.md),
[`fanout.md`](docs/providers/fanout.md) and [`webhooks.md`](docs/providers/webhooks.md).

Handlers can run in the web process (the default) or in a **worker**: set
`DC_WORKER_IN_PROCESS=off` on the web containers and run `npm run worker`
(Python: `python -m starter_crm.worker`) with the same environment and a store
both can reach. Compose has the whole arrangement behind a profile:

```sh
# in .env: DC_STORE=redis, DC_DATA=sqlite, DC_REDIS_URL=redis://redis:6379,
#          DC_WORKER_IN_PROCESS=off, DC_INSECURE_PRIVATE_SERVICES=on
docker compose --profile redis up --build
docker compose --profile python --profile python-redis up --build   # Python
```

**TLS.** With `DC_ENV=production`, Postgres and Redis on any host that is not
local must use TLS (`rediss://`, `sslmode=require`), or the server refuses to
start. The Compose project's own Valkey container sits on a private network, so
that profile sets `DC_INSECURE_PRIVATE_SERVICES=on`. Do not set it for a managed
database across the internet.

**Your modules' data** (`DC_DATA`, [`docs/providers/data.md`](docs/providers/data.md))
follows the event store: `sqlite` and `postgres` keep it in the same database, so
there is nothing more to set. With a Redis store, set `DC_DATA=sqlite` (one host)
or `DC_DATA=postgres`, because Redis is not a database for modules to keep their
data in; the server refuses to start in server mode until you do
(`data_provider_required`).

**Migrations** run at boot, under a lock, so several instances can start at once.
`npm run migrate:status` shows what has run.

**Webhook endpoint and sleeping hosts.** A host that freezes the process between
requests cannot run a worker. Use `DC_WEBHOOKS=inline` there, with handlers that
finish in about three seconds.

## Check a deployed host

```sh
STARTER_CRM_DEPLOYED_PASSCODE=... STARTER_CRM_DEPLOYED_WEBHOOK_SECRET=... \
  npm run test:deployed -- --url https://crm.example.com
```

It checks HTTPS, the security headers, `/healthz` and `/readyz`, caching and
gzip, that a stranger is refused, that a signed webhook is acknowledged in under
a second (and a replay, and a stale one, are handled), the session cookie, that
the live event stream stays open for 75 seconds and still delivers an event, and
then signs in with a real browser, in both front-ends. Without the passcode or
the secret, the checks that need them are skipped with a notice;
`--require-all` turns that into a failure.

It sends a few fictional events about made-up contacts (555 test numbers). They
appear in the app's activity feed. It never calls Drop Cowboy, and nothing goes
to a phone.

## Images

Tagged releases are published to GitHub Container Registry, for the repository
`<owner>/starter-crm`:

```
ghcr.io/<owner>/starter-crm          Node     :1.2.3   :1   :latest
ghcr.io/<owner>/starter-crm-python   Python   :1.2.3   :1   :latest
```

`:1.2.3` never changes, so deploy that and roll back by deploying the previous
one. `:1` and `:latest` move. Each image carries an SBOM and a signed
build-provenance attestation:

```sh
gh attestation verify oci://ghcr.io/<owner>/starter-crm:1.2.3 --owner <owner>
```

The release workflow ([`.github/workflows/images.yml`](.github/workflows/images.yml))
fails on any high or critical vulnerability that has a fix.

## Dev container and Codespaces

Open the repository in a dev container or a Codespace. It has Node 24 and
Python 3.13, runs `npm run setup -- --yes`, and forwards ports 8080 and 5173.
To receive webhooks in a Codespace, set port 8080's visibility to **Public** in
the Ports panel and use that address as `DC_PUBLIC_URL`. `mcp-session` mode does
not work there, because it checks the `Host` header for `localhost`.
