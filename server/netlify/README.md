# The Netlify variant

The Starter CRM on Netlify: the two front-ends on Netlify's CDN and the server in
Netlify Functions. It is the same server as `../node`, not a port of it: the
routes live in the web-standard core there (`createCore()`), and this folder
mounts that core in one function. The contract (`../CONTRACT.md`) and both test
suites are the same. `../../netlify.toml` holds the build. Node only.

| File | What it does |
|---|---|
| `functions/api.mjs` | Every path the CDN has no file for (API, webhook, health checks, event stream). |
| `functions/webhook-jobs.mjs` | The Async Workloads workload for `DC_WEBHOOKS=netlify-async`: runs one event's handlers. |
| `functions/maintenance.mjs` | The daily scheduled function: re-queue lost events, prune. Netlify refuses calls to it from outside. |
| `lib/core.js` | Boots the core on the first request and reuses it. Loads `../node/src` by file URL, outside the bundle. |
| `lib/webhook-job.js` | Turns the processor's answer into what Async Workloads expects: done, retry after a delay, or drop. |
| `lib/cdn-headers.js` | The `_headers` file: the core's security headers and caching, for the files the CDN serves. |
| `scripts/build.mjs` | Netlify's build: the React app, then `dist/` laid out as the core serves it, then `_headers`. |
| `scripts/serve.mjs` | `npm start`: the function behind a plain Node server, with the worker, for the test suites. |

## Why the core is not bundled

The core reads its migrations, JSON schemas, your handlers file, your custom
providers and the front-end files from disk. A bundle would move them, so
`lib/core.js` imports `../node/src/serverless.js` by a URL the bundler leaves
alone, `netlify.toml` uses the `nft` bundler, which keeps every file at its own
path, and `included_files` lists what the deployed function needs. Edit the core
in `../node/src` as before; this folder does not change. A file your server reads
from outside `server/node` goes in `included_files`, or it is missing from the
deployed function and the server says so at boot.

## Run it

```sh
npm ci --prefix ../node && npm ci --prefix ../../react && npm ci
STARTER_CRM_ROOT=/path/to/a/folder-with-.env npm start      # or set the variables
```

`npm start` is the long-running arrangement (`scripts/serve.mjs`): the core
serves the front-ends itself and the worker and maintenance loop run in the
process, like `../node`. The CDN, `_headers`, Async Workloads and the schedule
exist only on Netlify; `npm run test:deployed` checks them against a deploy. See
`../../HOSTING.md` for the setup.

## Differences from the Node server

- **No process between requests on Netlify.** `DC_WEBHOOKS` defaults to
  `netlify-async` and the store must be shared (`serverless_*` boot problems say
  so). Nothing is left running after a response: every promise is awaited first,
  and `context.waitUntil` is not used.
- **Boot problems** are printed to the function log and every request answers a
  generic `503 not_ready` (the problems name settings, so they never leave the
  server). Under `npm start` the process exits with the list instead.
- **The peer address** is Netlify's `context.ip`, from its edge, never
  `X-Forwarded-For`. Under `npm start` it is the socket's.
- **Static files** come from the CDN with the headers in `_headers`, which the build
  writes from the same configuration the function reads. A setting that changes
  them, such as `DC_CSP`, takes effect on the next deploy, as for the function.
- **Streams** end after `DC_EVENTS_MAX_STREAM_SECONDS` (25 on Netlify), with a
  keepalive every 5 seconds; the browser reconnects and replays from
  `Last-Event-ID`.
- **Async Workloads.** The root `package.json` depends on
  `@netlify/async-workloads` as well as this folder's, at the same version: the
  extension writes its router into `.netlify/functions-internal` at the root, and
  the router imports the package from there.
- **What that package leaves out.** `@netlify/async-workloads` declares
  `@netlify/sdk`, and through it about 1,600 packages with dozens of high
  `npm audit` advisories, some of which no release fixes. It never imports any
  of them: its code uses only `@netlify/blobs`, `@lukeed/ms`, `commander` and
  Node's built-ins. So both `package.json` files install `unused-netlify-sdk`,
  an empty package, in its place, and override the package's dependency on an
  old copy of itself so only one copy is installed. A test fails if a new
  release imports anything else; if that happens, add what it needs rather than
  removing the stand-in. Keep the two `overrides` the same.
