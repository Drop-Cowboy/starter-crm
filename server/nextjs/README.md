# The Next.js variant

The Starter CRM as a Next.js App Router app, for Vercel and for any host that runs
`next start`. It is the same server as `../node`, not a port of it: the routes live
in the web-standard core there (`createCore()`), and this folder mounts that core
in three route handlers. The two front-ends, the contract (`../CONTRACT.md`) and
both test suites are the same.

| File | What it does |
|---|---|
| `app/[[...path]]/route.js` | Every path the core answers (API, webhook, health checks, front-ends). |
| `app/internal/queue/webhook-jobs/route.js` | The Vercel Queues consumer. `vercel.json` binds it to the topic. |
| `app/internal/maintenance/route.js` | The daily Vercel Cron: re-queue lost events, prune. Needs `CRON_SECRET`. |
| `lib/core.js` | Boots the core on the first request and reuses it. Loads `../node/src` by file URL, outside the bundle. |
| `scripts/serve.mjs` | `npm start`: a long-running server with the peer address, raw path and SIGTERM drain. |
| `scripts/build.mjs` | `npm run build`: builds the React app, then Next. |
| `next.config.mjs`, `vercel.json` | Tracing of the core's files, the queue trigger, the cron. |

## Why the core is not bundled

The core reads its migrations, JSON schemas, your handlers file, your custom
providers and the front-end files from disk. A bundle would move them, so
`lib/core.js` imports `../node/src/serverless.js` with the bundler told to leave it
alone, and `next.config.mjs` lists what the deployed function needs
(`outputFileTracingIncludes`). Edit the core in `../node/src` as before; this
folder does not change.

## Run it

```sh
npm ci --prefix ../node && npm ci --prefix ../../react && npm ci
npm run build
STARTER_CRM_ROOT=/path/to/a/folder-with-.env npm start      # or set the variables
```

`npm start` is the long-running arrangement (`scripts/serve.mjs`): the worker and
maintenance loop run in the process, like `../node`. On Vercel there is no such
process, so the settings differ (a queue, Postgres, a cron); see `HOSTING.md`.

## Differences from the Node server

- **No process between requests on Vercel.** `DC_WEBHOOKS` defaults to
  `vercel-queue` and the store must be shared (`serverless_*` boot problems say
  so). Nothing is left running after a response: every promise is awaited first.
- **Boot problems** are printed to the function log and every request answers a
  generic `503 not_ready` (the problems name settings, so they never leave the
  server). Under `npm start` the process exits with the list instead.
- **The peer address** comes from the platform on Vercel (`x-real-ip`) and from
  the socket under `npm start`. Plain `next start` gives route handlers neither, so
  the local-only dev session refuses there.
- **Streams** end after `DC_EVENTS_MAX_STREAM_SECONDS` (290 on Vercel); the browser
  reconnects and replays from `Last-Event-ID`.
