# Testing the Starter CRM

You do not need a Drop Cowboy account. These tests never call the live API.

One command runs everything, from the starter root:

```sh
npm test
```

It runs these stages in order. A failing stage does not stop the rest, so you
see every problem at once. It ends with a count per stage:

| Stage | What it checks |
| --- | --- |
| `shared` | Unit tests for the code both front-ends share (`shared/test`, `node --test`) |
| `server:node` | The Node server's own tests (`server/node/test`, Vitest) |
| `server:python` | The Python server's own tests (`server/python/tests`, pytest) |
| `conformance:node` | The [server contract](../server/CONTRACT.md), run against the Node server |
| `conformance:python` | The same contract suite, run against the Python server |
| `lint:nextjs`, `nextjs:build` | ESLint for the Next.js variant, then `next build` (it builds the React app first) |
| `conformance:nextjs` | The same contract suite, run against the Next.js variant through its launcher (`server/nextjs/scripts/serve.mjs`) |
| `netlify`, `lint:netlify`, `netlify:build` | The Netlify variant's own tests (the Async Workloads job, `_headers`, the functions' routing), ESLint, then its build (`dist/` and `_headers`) |
| `conformance:netlify` | The same contract suite, run against the Netlify function through its launcher (`server/netlify/scripts/serve.mjs`) |
| `react` | The React app's unit tests (Vitest) |
| `react:build` | Builds `react/dist`, which the browser tests serve at `/react/` |
| `e2e:{node,python,nextjs,netlify}:{vanilla,react}` | Browser tests: each server (and the Next.js and Netlify variants) with each front-end |
| `container:node`, `container:python` | Builds the image, runs the server contract suite against a container of it, then the smoke checks (non-root, healthy and read-only, clean SIGTERM stop) and the image-contents leak check. Needs Docker. |
| `container:compose` | `compose.yaml` builds and serves both servers with secrets read from files, and no secret reaches the container's environment or logs. Needs Docker. |
| `leaks` | Static checks that nothing private ships in the starter |

The first run installs what is missing: `npm ci` in each package, Chromium for
Playwright, and a virtualenv in `server/python/.venv`. Python stages need
Python 3.11 or newer. If none is found they are skipped with a notice; set
`PYTHON=/path/to/python3` to choose one.

Other entry points:

```sh
npm run test:fast     # everything except the browser and Docker: unit, conformance, leaks
npm run test:container # the images and compose.yaml (Docker)
npm run test:deployed -- --url https://crm.example.com   # a running host (see below)
npm run test:e2e      # build React, then the four browser runs
npm run test:leaks    # just the leak checks
node tests/run-all.mjs --list
node tests/run-all.mjs --only conformance:python,e2e:python:vanilla
```

## Browser tests (`tests/e2e`)

The browser tests drive the real app in Chromium: a real starter server, the
real front-end, and the real Building Blocks. Only Drop Cowboy itself is
replaced. The one request that leaves your machine is the first run's download
of the pinned Building Blocks release. The table below shows how each outside
dependency is handled:

| The app talks to | In the tests |
| --- | --- |
| The Drop Cowboy API that mints tokens (server side) | A fake API in the test process (`support/fake-dropcowboy.js`). The starter server is started with `DROPCOWBOY_API_BASE` pointing at it. |
| The Drop Cowboy API the Building Blocks call (browser side) | The same fake answers, through Playwright request interception. Every record uses a raw UUID (`support/data.js`). |
| The Building Blocks CDN | Served from local copies of the bundles (see below). Each file is checked against the `integrity` hash in the manifest first. |
| Drop Cowboy sign-in (login mode) | A fake authorize/token pair in `specs/login-mode.spec.js` |
| Anything else | Blocked. A test that reaches any other host fails. |

The fake enforces the same scopes as the real API. If a token lacks a scope,
the request is refused with 403. If a token is revoked or unknown, it gets
401. A widget calling an endpoint the fake does not know is reported in the
test output.

Run them on their own:

```sh
cd tests/e2e
npm ci && npx playwright install chromium
(cd ../../react && npm ci && npm run build)    # the react project serves react/dist

npx playwright test                       # Node server, both front-ends
npx playwright test --project=vanilla     # one front-end
npx playwright test specs/contacts.spec.js
```

To test against the Python server, set the command that starts it:

```sh
SERVER_CMD="../../server/python/.venv/bin/python -m starter_crm" \
SERVER_CWD=../../server/python npx playwright test
```

`SERVER_CMD` and `SERVER_CWD` are the same variables the conformance suite
uses. A server in any other language passes the browser tests if it starts
with that command and honors the [contract](../server/CONTRACT.md).

### What every test checks

Every test also runs two checks as it finishes:

- **No token leaks.** No Drop Cowboy token, API key, webhook secret or
  sign-in token may appear in any of these places:
  - the page's DOM, including shadow roots and input values;
  - URLs;
  - `localStorage`, `sessionStorage` or cookies;
  - the browser console;
  - the starter server's output.

  Anything shaped like a JWT counts as a leak too, even one the test did not
  mint. While a sign-in is in flight, `sessionStorage` holds the PKCE verifier
  and state, never a token.
- **Accessibility.** Pages the test opens are scanned with
  [axe](https://github.com/dequelabs/axe-core). Any serious or critical
  WCAG 2.1 A/AA violation fails the test.

### Which Building Blocks are tested

The bundles are looked for in this order:

1. `DC_E2E_CDN_DIR`, if set
2. `v2/app/src/assets`, when the starter sits inside the Drop Cowboy monorepo
3. `tests/e2e/.cdn-cache/v<version>/`, the release pinned by
   `DEFAULT_CDN_VERSION` in `shared/config.js`

When neither of the first two exists, Playwright's global setup
(`support/global-setup.js`) downloads the pinned release from
`webforms.dropcowboy.com` into the cache once, checking every bundle against
its integrity hash. Git ignores the cache. Building Blocks are closed source,
so never commit them; `tests/leak-check.test.js` fails if you do.

If a bundle does not match its manifest hash, the tests fail and tell you to
rebuild the Building Blocks CDN bundles that sit next to the manifest.

### The scenarios

| Spec | Covers |
| --- | --- |
| `setup.spec.js` | The setup checklist |
| `contacts.spec.js` | List, search, create, duplicate detection, a 401 that refreshes the token exactly once |
| `contact.spec.js` | The contact card; editing sends only the changed fields; delete asks first; Call and Text hand off to the Dock |
| `widgets.spec.js` | Pipeline, inbox, campaigns (read-only), and phone (renting a number asks first) |
| `refusals.spec.js` | No carrier connected (`byoc_required`): contacts still work and the banner explains. No consent (`consent_required`): the guidance shown |
| `sandbox.spec.js` | The seed contacts are unique 555 test numbers. Sandbox mode (`sandbox_only`): the Setup notice, the hint under Call and Text, a text to a test number answered by the automatic reply through the webhook, a text to a real number refused. Live only: a call to an answering test number connects and ends normally, and one to the busy number does not connect |
| `activity.spec.js` | A signed webhook reaches the activity feed over SSE; a forged one is refused |
| `login-mode.spec.js` | Sign-in with PKCE; tokens minted with the user's own token; a reload forgets it |
| `login-not-configured.spec.js` | Login mode without a client ID shows how to set it up |
| `mcp-session-mode.spec.js` | Development-session mode without a session file shows what to run |

## Leak checks (`tests/leak-check.test.js`)

These checks scan every text file in the starter. They skip `node_modules`,
virtualenvs, build output, test output and your local `.env` files. They fail
on any of the following:

- private keys and well-known credential formats (AWS, GitHub, Slack, Stripe, Google, npm);
- values filled in `.env.example`;
- JWTs that look real. Test placeholders are fine: their signature decodes to
  text such as `signature`;
- type-prefixed IDs. The starter uses plain UUIDs;
- Drop Cowboy hostnames that are not public;
- cloud-internal hostnames and private IP addresses.

If [gitleaks](https://github.com/gitleaks/gitleaks) is installed, it also runs
with `.gitleaks.toml`. If it is not, that check is skipped with a notice.

## Real services (`tests/services.compose.yml`)

Some checks run against a real service instead of a stand-in. Today that is an
OpenBao, the open-source Vault fork, for the `vault` secrets provider
(conformance suite 20). Start it with:

```sh
docker compose -f tests/services.compose.yml up -d --wait
```

It runs in dev mode on `127.0.0.1:8200` with a throwaway root token, so never
put anything real in it. The suite skips with a notice when nothing answers, so
a machine without Docker still gets a green run. `SUITE=<regex>` runs only the
matching conformance files, for example `SUITE=20- node run.js` in
`server/conformance`.

## A deployed host (`npm run test:deployed`)

`npm run test:deployed -- --url https://crm.example.com` checks a host that is
already running (see [`HOSTING.md`](../HOSTING.md)): HTTPS, headers, caching and
gzip, `/healthz` and `/readyz`, a webhook acknowledged in under a second, an
event stream that stays open past the host's idle limit, and a browser sign-in
in both front-ends. It needs the passcode and a webhook secret the host accepts
(`STARTER_CRM_DEPLOYED_PASSCODE`, `STARTER_CRM_DEPLOYED_WEBHOOK_SECRET`), and
skips the checks that need them without. It is not part of `npm test`, because
it needs a host. It sends only a few fictional events and never calls Drop
Cowboy.

Three things bend to the host. A first webhook over a second passes if it took
under 4 seconds and a second one, now warm, takes under one: a function that had
gone cold boots on that request. A page a CDN serves carries the CDN's request id
(`x-nf-request-id` on Netlify) instead of the server's. On Netlify, which cuts a
stream at 30 seconds, pass `--hold-seconds 15` instead of the default 75.
`PLAYWRIGHT_VIDEO=on` records the browser runs under `tests/e2e/test-results/deployed`.

The host checks are `tests/deployed/host.test.js` and the browser spec is
`tests/e2e/deployed/deployed.spec.js`. They check the host, not Drop Cowboy
data: the contact specs in `tests/e2e/specs` (and `npm run test:live`) start
their own server, so they do not run against a deployed one.
