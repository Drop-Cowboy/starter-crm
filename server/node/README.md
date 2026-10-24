# Starter CRM server (Node)

A small server for the Drop Cowboy Starter CRM, written as web-standard
handlers (`Request` in, `Response` out) with Express as a thin adapter. It does the two jobs a
browser must never do itself:

- **mints short-lived site tokens**, with your API key so the key stays on the
  server, or (coming soon) in `login` mode with your Drop Cowboy sign-in, and
- **verifies signed webhooks** from Drop Cowboy and streams them to the open
  page.

It implements [`../CONTRACT.md`](../CONTRACT.md) and passes the suite in
[`../conformance/`](../conformance/). The front-ends only use the routes in that
contract, so they work the same on this server or the Python one.

Dependencies are `express`, `dotenv` and `jose` (loaded only when you choose
`DC_IDENTITY=oidc`). Calls to Drop Cowboy use Node's
built-in `fetch`, and signatures use `node:crypto`, so you can see every HTTP
request the starter makes.

## Run it

Needs Node 24 or later.

```bash
cp ../../.env.example ../../.env   # then fill it in
npm install
npm start                          # http://127.0.0.1:8080
```

`npm run dev` restarts on file changes. The server reads `.env` from the starter
root (two folders up); variables already in your environment win.

## Auth modes

`DC_AUTH_MODE` picks how the browser gets its site token.

| Mode | Who it is for | What this server does |
|---|---|---|
| `server` (default) | Production: your CRM's own users | Mints tokens with your API key at `POST /api/dropcowboy/token`. Your users never need a Drop Cowboy login. |
| `mcp-session` | Developing with an AI agent | Hands the browser the token your agent wrote to `.dropcowboy/session.json`, to this machine only. |
| `login` (coming soon) | You, the account owner, trying the starter | Serves the page and the Auth0 settings. You sign in with Drop Cowboy in the browser, which sends that access token to `POST /api/dropcowboy/token`; this server forwards it to Drop Cowboy to mint. No API key needed. **Not usable yet:** it needs a public sign-in client (`AUTH0_CLIENT_ID`) that has not been created, so the page shows "Sign-in is not set up yet". |

## Environment

| Variable | Needed for | Notes |
|---|---|---|
| `DC_AUTH_MODE` | | `server` (default), `mcp-session` or `login` |
| `DROPCOWBOY_API_KEY`, `DROPCOWBOY_API_SECRET` | `server` | Needs the `numbers:write` scope to mint, and `balance:read` for the setup check |
| `DROPCOWBOY_SITE_ID` | `login`, `server` | One UUID per deployed app; keep it stable. It partitions the embed inbox. |
| `DC_IDENTITY` | `server` | `dev` (default, local only), `passcode`, `oidc` or a path to your own provider |
| `DC_PASSCODE` | `passcode` | 12 or more characters; a secret |
| `DC_OIDC_ISSUER`, `DC_OIDC_AUDIENCE`, `DC_OIDC_JWKS_URL` | `oidc` | The issuer must equal the token's `iss`; the key set URL is optional |
| `STARTER_CRM_USER_ID` | `dev` | A UUID for the dev user; optional with `passcode` |
| `DC_SECRETS`, `DC_RATE_LIMIT`, `DC_LOG`, `DC_OBSERVER` | | Provider choices; see [`docs/providers/`](../../docs/providers/identity.md) |
| `DC_CSP`, `DC_CORS_ORIGINS`, `DC_TOKEN_CACHE`, `DC_LOG_FORMAT`, `DC_LOG_REQUESTS`, `DC_SECRETS_DIR`, `DC_SECRETS_REFRESH_SECONDS` | | Security headers, CORS, token reuse, logging and secret files; see `.env.example` |
| `DROPCOWBOY_WEBHOOK_SECRET` | webhooks | The webhook's signing secret. Comma-separate several: each webhook has its own. |
| `DROPCOWBOY_API_BASE` | | Default `https://api-v2.dropcowboy.com` |
| `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_AUDIENCE` | `login` | Public values, safe in the browser |
| `DC_CDN_VERSION` | | Pins the widget version the page loads |
| `HOST`, `PORT` | | Default `127.0.0.1:8080` |

In `server` mode the server refuses to start until the key, secret, site id and
starter user id are set, and tells you which are missing. In `login` mode it
needs only the site id.

## Routes

| Route | Mode | What it does |
|---|---|---|
| `GET /healthz` | all | `{"ok": true}` |
| `GET /api/config` | all | Public settings for the browser. Never a secret. |
| `POST /api/dropcowboy/token` | `login`, `server` | `{"purpose": "session" \| "contacts" \| "campaigns" \| "phone"}` returns `{token, expires_at}` |
| `GET /api/dropcowboy/readiness` | `login`, `server` | What the account still needs before the widgets work |
| `GET /__dev/session` | `mcp-session` | The agent-minted token, loopback only |
| `POST /webhooks/dropcowboy` | all | Verifies and records a Drop Cowboy webhook |
| `GET /api/events` | all | Server-Sent Events stream of verified webhooks |
| `GET /shared/...` | all | The ES modules the front-ends share, as `text/javascript`. Files only: anything else is `404`. |
| everything else | all | `vanilla/` at `/`, the built React app at `/react/` |

Errors always look like `{"error": {"code", "message"}}`. Drop Cowboy's own
codes (`payment-required`, `consent_required`, `insufficient-scope`, ...) pass
through unchanged. See the contract for the full list.

### Why the token route takes a purpose, not scopes

The browser says what it needs a token *for*; `src/token.js` maps that to
scopes:

| `purpose` | Scopes |
|---|---|
| `session` | `dialer:webrtc`, `contacts` |
| `contacts` | `contacts` |
| `campaigns` | `campaigns` |
| `phone` | `phone:hub` |

If the browser could choose scopes, anyone with devtools could ask for
`numbers:write` and rent numbers on your account. Each page gets the least it
needs: the Dock uses `session`, while the Contacts, Contact and Pipeline pages
use `contacts`. Drop Cowboy only checks for a connected carrier and a balance
when a token can call, so the contacts pages work for a team that has neither.

### Login mode: minting with your sign-in

Drop Cowboy's mint endpoint is first-party only, so a page on your origin
cannot read its answer. In `login` mode the browser therefore signs in with
Drop Cowboy and hands the access token to this server:

```http
POST /api/dropcowboy/token
Authorization: Bearer <access token>
Content-Type: application/json

{"purpose": "session"}
```

`requireLogin()` in `src/auth.js` checks the header is shaped like a bearer and
nothing more; `src/upstream.js` forwards it to Drop Cowboy, which verifies it.
No API key is sent, and no `sub`: Drop Cowboy knows who signed in. Readiness
works the same way.

| Answer | Meaning | Front-end should |
|---|---|---|
| `401 login_required` | No well-formed bearer | Sign the user in |
| `401 login_expired` | Drop Cowboy refused the token | Sign in again, then retry |

In `server` mode the same Drop Cowboy `401` becomes `502 upstream_auth_failed`
instead: there it means your API key is wrong, and signing in again would not
help. The access token is never logged (`src/log.js` scrubs anything shaped like
`Bearer <token>`) and never sent back.

### Receiving webhooks

Create a webhook for your URL: one request carries every event type you want
(`event_types`). The response has the `webhook_id` and, only once, its
`signing_secret`. An account can hold up to 50 webhooks, each with its own
secret, and creating one never replaces another. Put every secret in
`DROPCOWBOY_WEBHOOK_SECRET`, comma-separated; a delivery is accepted when any of
them matches. Rotate one with
`POST /register/public/webhooks/{webhook_id}/rotate-secret`. The old secret
stops working at once, so add the new one right away.

```bash
curl -X POST https://api-v2.dropcowboy.com/register/public/webhooks \
  -H "x-key: $DROPCOWBOY_API_KEY" -H "x-secret: $DROPCOWBOY_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"event_types": ["contact.msg.received", "contact.msg.sent"], "hook_url": "https://your-tunnel.example.com/webhooks/dropcowboy"}'
```

Drop Cowboy never delivers to private or loopback addresses, so use an HTTPS tunnel while you work
locally. The signature covers the raw request body, which is why
`src/app.js` gives this route `express.raw()` instead of a JSON parser.

## Files

| File | Purpose |
|---|---|
| `src/index.js` | Loads `.env`, checks config, starts listening |
| `src/app.js` | `createApp(config)`: wires the routes. Tests use it without listening. |
| `src/config.js` | Reads and validates the environment |
| `src/auth.js` | `requireUser()`, which asks the chosen identity who is calling, and the login-mode bearer check |
| `src/providers/` | The built-in identity (`dev`, `passcode`, `oidc`), secrets (`env`, `file`), rate-limit (`memory`, `off`) and log (`console`) providers |
| `src/security.js`, `src/request-context.js`, `src/hooks.js` | Response headers, CORS and CSRF; request ids; observer hooks |
| `src/token.js` | The purpose-to-scope allowlist and the mint call |
| `src/readiness.js` | The setup check, trimmed to what the page shows |
| `src/dev-session.js` | The loopback-only MCP session hand-off |
| `src/webhooks.js` | Signature verification and de-duplication |
| `src/events.js` | In-memory event store and the SSE stream |
| `src/upstream.js` | Every call to Drop Cowboy: API key or forwarded bearer, 10 s timeout, error mapping |
| `src/errors.js` | The error envelope |
| `src/log.js` | A logger that scrubs secrets and tokens |
| `src/static.js` | Serves the front-ends and `shared/` |

## Test

```bash
npm test             # unit tests (Vitest)
npm run conformance  # the contract suite, against a mock Drop Cowboy API
npm run lint
```

No test talks to the real Drop Cowboy API or needs credentials.

## Going to production

- **Choose a real identity.** `DC_ENV=production` refuses `DC_IDENTITY=dev`.
  Use `passcode`, `oidc` or your own provider (`../../CUSTOMIZE.md`).
- **Restrict the readiness route** to your admins; it describes your account.
- **Run behind HTTPS.** Browsers only allow the microphone on HTTPS pages (and
  `localhost`).
- **Keep secrets in a secret manager**, not a `.env` file on the server.
- **Check the rate limit fits.** The token route and sign-in are limited per
  process; use a shared limiter on several instances (`docs/providers/ratelimit.md`).
- **Store webhook events durably** (your database or a queue) before you answer,
  and de-duplicate on `event_id` there. The in-memory store here forgets
  everything on restart and is per process.
- **Use one stable `DROPCOWBOY_SITE_ID`** per deployment.
- **Never set `DC_AUTH_MODE=mcp-session`** outside your own machine.
