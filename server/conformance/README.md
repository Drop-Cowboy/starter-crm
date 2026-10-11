# Conformance suite

One HTTP test suite that every Starter CRM server must pass, whatever language it
is written in. It is what keeps the Node and Python servers identical, so the
front-ends never need to know which one they are talking to.

It needs Node 22.12 or later and has no dependencies. It never talks to the real
Drop Cowboy API and needs no credentials.

## Run it

```bash
node run.js                                                          # the Node server (../node)
SERVER_CMD="python -m starter_crm" SERVER_CWD=../python node run.js   # the Python server
```

Or `npm test`, `npm run test:node`, `npm run test:python` from this folder.

| Variable | Default | Meaning |
|---|---|---|
| `SERVER_CMD` | `node src/index.js` | Command line that starts the server under test. Run through the shell. |
| `SERVER_CWD` | `../node` | Folder to run it in. Relative paths resolve from your current directory. |

For the Python server, activate its virtualenv first (or point `SERVER_CMD` at
the venv's `python`); the runner passes `PATH` and `VIRTUAL_ENV` through.

## What the runner does

1. Starts `mock-upstream.js`, a stand-in Drop Cowboy API, on a free port.
2. Creates a temporary starter root for each auth mode (`login`, `server`,
   `mcp-session`) with its own `.env`, front-end fixtures and `.dropcowboy/`
   folder.
3. Starts `SERVER_CMD` once per mode with only `STARTER_CRM_ROOT`, `HOST`, `PORT`
   and a few basics (`PATH`, `HOME`, `VIRTUAL_ENV`, ...) in its environment.
   Everything else comes from that root's `.env`, so this also checks that the
   server loads `.env` from `STARTER_CRM_ROOT`. Nothing from your own shell or
   `.env` leaks in.
4. Waits for `GET /healthz`, then runs every `suite/*.test.js` with `node --test`.
5. Fails the run if any server printed an API key, API secret, webhook secret,
   site token or login-mode access token to stdout or stderr. The access tokens
   are deliberately not JWT-shaped, so a server that logs them is caught even
   if it scrubs JWTs.
6. Stops everything and deletes the temporary roots.

`DROPCOWBOY_API_BASE` points at the mock and `DROPCOWBOY_TIMEOUT_MS` is set to
1500 so the timeout tests run quickly.

## What it covers

| File | Covers |
|---|---|
| `01-health-config.test.js` | `/healthz`, `/api/config` per mode, no secrets in config, routes absent in `mcp-session`, unknown routes |
| `02-token.test.js` | Both minting modes. Scopes per purpose (`session`, `contacts`, `campaigns`, `phone`); server mode sends only `x-key`/`x-secret` and never a browser bearer; login mode sends only the browser's bearer and no `sub`; `login_required` for a missing or malformed bearer, checked before the body; `login_expired` for a refused token; browser can't inject scope/sub/site_id/ttl; invalid purposes, and an `invalid_purpose` message that names every purpose; every upstream error mapping in both modes, including `401` becoming `502 upstream_auth_failed` vs `401 login_expired`; no raw upstream body, secret or access token in responses; `Retry-After` |
| `03-readiness.test.js` | Field allowlist and nothing private passed through, in server and login modes; which credential goes upstream; `login_required`, `login_expired`; error mapping |
| `04-dev-session.test.js` | Missing, valid, expired and malformed session files, `Host` (DNS rebinding) check, forwarding headers ignored |
| `05-webhooks.test.js` | Valid deliveries, raw-body signing, multiple secrets, wrong secret, tampering, version, missing headers, stale and malformed timestamps, replay de-duplication, `503` without a secret |
| `06-events.test.js` | SSE delivery of a verified webhook, `Last-Event-ID` replay, rejected and duplicate deliveries not pushed |
| `07-static.test.js` | Front-end serving, client-route fallback, path traversal, the "no front-end yet" text; `/shared/` modules as `text/javascript` in every mode, no index or listing or fallback, dotfiles, and escapes via `../`, `%2e%2e`, `%2f`, raw and `%5c` backslashes |
| `08-boot.test.js` | Fails fast on missing or invalid config without printing secrets; login mode needs the site id and nothing server-only |

One rule is not tested here: refusing a **non-loopback peer** on
`/__dev/session` needs a second machine. Each server covers it in its own unit
tests by faking the socket address.

## The mock

`mock-upstream.js` answers `POST /phone/public/embed/token` and
`GET /register/public/integration-readiness`, records every request, and has
control routes the suite uses.

Like Drop Cowboy, it answers `401` unless a request carries exactly one valid
credential: the runner's API key and secret, or the one access token it
accepts. Every recorded request has a `credentials` field, `api_key`,
`bearer`, `both` or `none`, so tests can assert a server sent exactly the kind
its mode calls for. Any other bearer, such as the suite's expired token, gets
`401`.

| Route | Body | Effect |
|---|---|---|
| `POST /__mock/scenario` | `{"route": "token" \| "readiness", "scenario": "..."}` | Sets the answer for that route until reset |
| `POST /__mock/reset` | | Back to `success`, request log cleared |
| `GET /__mock/requests` | | Every request received since the last reset |

Scenarios: `success`, `payment_required` (402), `insufficient_scope` (403),
`consent_required` (403, legacy shape), `unauthorized` (401), `rate_limited`
(429 with `Retry-After`), `server_error` (500), `not_json` (HTML 502),
`bad_success` (200 without a token), `slow` (answers after the server's timeout).

Every error body carries the string `UPSTREAM-RAW-BODY-CANARY` in a field a
server should not forward, and the suite checks it never reaches a response.

## Porting the server to another language

Read [`../CONTRACT.md`](../CONTRACT.md), build to it, then point `SERVER_CMD` at
your server. When this suite passes, both front-ends work on it unchanged.
