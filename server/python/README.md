# Starter CRM server (Python)

A small Flask server for the Drop Cowboy Starter CRM. It does the two jobs a
browser must never do itself:

- **mints short-lived site tokens**, with your API key so the key stays on the
  server, or (coming soon) in `login` mode with your Drop Cowboy sign-in, and
- **verifies signed webhooks** from Drop Cowboy and streams them to the open
  page.

It implements [`../CONTRACT.md`](../CONTRACT.md) and passes the suite in
[`../conformance/`](../conformance/). The front-ends only use the routes in that
contract, so they work the same on this server or the Node one.

Dependencies are `Flask`, `python-dotenv`, `gunicorn` and `PyJWT` (loaded only
when you choose `DC_IDENTITY=oidc`). Calls to Drop Cowboy use the
standard library's `urllib`, and signatures use `hmac`, so you can see every
HTTP request the starter makes.

## Run it

Needs Python 3.11 or later.

```bash
cp ../../.env.example ../../.env   # then fill it in
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m starter_crm               # http://127.0.0.1:8080
```

The server reads `.env` from the starter root (two folders up); variables
already in your environment win.

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
| `DROPCOWBOY_SITE_ID` | `login`, `server` | One UUID per deployed app; keep it stable. It partitions the embed inbox. Checked in every mode when set. |
| `DC_IDENTITY` | `server` | `dev` (default, local only), `passcode`, `oidc` or a path to your own provider |
| `DC_PASSCODE` | `passcode` | 12 or more characters; a secret |
| `DC_OIDC_ISSUER`, `DC_OIDC_AUDIENCE`, `DC_OIDC_JWKS_URL` | `oidc` | The issuer must equal the token's `iss`; the key set URL is optional |
| `STARTER_CRM_USER_ID` | `dev` | A UUID for the dev user; optional with `passcode` |
| `DC_SECRETS`, `DC_RATE_LIMIT`, `DC_LOG`, `DC_OBSERVER` | | Provider choices; see [`docs/providers/`](../../docs/providers/identity.md). A custom provider is a `.py` file. |
| `DC_CSP`, `DC_CORS_ORIGINS`, `DC_TOKEN_CACHE`, `DC_LOG_FORMAT`, `DC_LOG_REQUESTS`, `DC_SECRETS_DIR`, `DC_SECRETS_REFRESH_SECONDS` | | Security headers, CORS, token reuse, logging and secret files; see `.env.example` |
| `DROPCOWBOY_WEBHOOK_SECRET` | webhooks | The webhook's signing secret. Comma-separate several: each webhook has its own. |
| `DROPCOWBOY_API_BASE` | | Default `https://api-v2.dropcowboy.com` |
| `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_AUDIENCE` | `login` | Public values, safe in the browser |
| `DC_CDN_VERSION` | | Pins the widget version the page loads |
| `HOST`, `PORT` | | Default `127.0.0.1:8080` |

Two more exist for tests: `STARTER_CRM_ROOT` (where `.env`, `.dropcowboy/` and
the front-ends are looked up; read from the real environment only, never from
`.env`) and `DROPCOWBOY_TIMEOUT_MS` (default `10000`).

In `server` mode the server refuses to start until the key, secret, site id and
starter user id are set, and tells you which are missing. In `login` mode it
needs only the site id. A site id that is not a UUID stops it in any mode.

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

The browser says what it needs a token *for*; `starter_crm/token.py` maps that
to scopes:

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

`require_login` in `starter_crm/auth.py` checks the header is shaped like a
bearer and nothing more; `starter_crm/upstream.py` forwards it to Drop Cowboy,
which verifies it. No API key is sent, and no `sub`: Drop Cowboy knows who
signed in. Readiness works the same way.

| Answer | Meaning | Front-end should |
|---|---|---|
| `401 login_required` | No well-formed bearer | Sign the user in |
| `401 login_expired` | Drop Cowboy refused the token | Sign in again, then retry |

In `server` mode the same Drop Cowboy `401` becomes `502 upstream_auth_failed`
instead: there it means your API key is wrong, and signing in again would not
help. The access token is never logged (`starter_crm/log.py` scrubs anything
shaped like `Bearer <token>`) and never sent back.

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

Drop Cowboy never delivers to private or loopback addresses, so use an HTTPS
tunnel while you work locally. The signature covers the raw request body, which
is why `starter_crm/webhooks.py` reads `request.get_data()` and never
`request.get_json()`.

## Files

| File | Purpose |
|---|---|
| `starter_crm/__main__.py` | `python -m starter_crm`: loads `.env`, checks config, starts listening |
| `starter_crm/app.py` | `create_app(config)`: wires the routes. Tests use it without listening. |
| `starter_crm/config.py` | Reads and validates the environment |
| `starter_crm/auth.py` | `require_user()`, which asks the chosen identity who is calling, and the login-mode bearer check |
| `starter_crm/providers/` | The built-in identity (`dev`, `passcode`, `oidc`), secrets (`env`, `file`), rate-limit (`memory`, `off`) and log (`console`) providers |
| `starter_crm/provider_check.py` | `python -m starter_crm.provider_check <kind> <path>`, which checks a provider you wrote |
| `starter_crm/security.py`, `hooks.py`, `token_cache.py` | Response headers, CORS and CSRF; observer hooks; the site token cache |
| `starter_crm/token.py` | The purpose-to-scope allowlist and the mint call |
| `starter_crm/readiness.py` | The setup check, trimmed to what the page shows |
| `starter_crm/dev_session.py` | The loopback-only MCP session hand-off |
| `starter_crm/webhooks.py` | Signature verification and de-duplication |
| `starter_crm/events.py` | In-memory event store and the SSE stream |
| `starter_crm/upstream.py` | Every call to Drop Cowboy: API key or forwarded bearer, timeout, no redirects, error mapping |
| `starter_crm/errors.py` | The error envelope |
| `starter_crm/log.py` | A logger that scrubs secrets and tokens |
| `starter_crm/static.py` | Serves the front-ends and `shared/` |
| `starter_crm/json_utils.py` | JSON parsing that matches JavaScript's, so both servers accept the same input |

## How it maps to the contract

| Contract section | Where |
|---|---|
| Configuration, Boot | `config.py` (`load_config` returns every problem at once), `__main__.py` (exits 1) |
| Error envelope, passing through Drop Cowboy errors | `errors.py` (`from_upstream`, `upstream_code`) |
| `POST /api/dropcowboy/token` | `token.py`, `auth.py` (`require_user`, `require_login`), `upstream.py` |
| `GET /api/dropcowboy/readiness` | `readiness.py` (`pick_readiness`) |
| `GET /__dev/session` | `dev_session.py` (peer address, `Host` check, file checks) |
| `POST /webhooks/dropcowboy` | `webhooks.py` (`verify_signature`), `events.py` (de-duplication) |
| `GET /api/events` | `events.py` |
| Static files, shared modules | `static.py` (`FrontEnd`, `serve_shared`) |
| No secrets in logs | `log.py`, plus Werkzeug's own logger quieted and filtered in `__main__.py` |

A few places where Python needs care that JavaScript does not:

- **`bool` is an `int`.** `isinstance(True, int)` is true, so `json_utils.is_number`
  rules booleans out wherever the contract says "a number".
- **`\d` matches non-ASCII digits** and **`$` matches before a trailing newline.**
  Patterns use `[0-9]` and `re.fullmatch`.
- **`json.loads` accepts `NaN` and `Infinity`.** `json_utils.parse_json` refuses
  them, as `JSON.parse` does.
- **`urllib` follows redirects and honours proxy settings by default.** Both are
  turned off in `upstream.py`, so the API key or the user's access token only
  ever goes to `DROPCOWBOY_API_BASE`.
- **Requests run on several threads.** `EventStore` takes a lock, checks for a
  duplicate and stores in one step, and hands a new stream its replay and its
  live feed together so no event falls between them.

## Test

```bash
pip install -r requirements-dev.txt
pytest                        # unit tests
ruff check . && ruff format --check .

# The contract suite, against a mock Drop Cowboy API (needs Node 24+).
# Run it with this virtualenv active so `python` is the venv's.
cd ../conformance && npm run test:python
```

No test talks to the real Drop Cowboy API or needs credentials.

## Going to production

- **Choose a real identity.** `DC_ENV=production` refuses `DC_IDENTITY=dev`.
  Use `passcode`, `oidc` or your own provider (`../../CUSTOMIZE.md`).
- **Use a production WSGI server.** `python -m starter_crm` runs Flask's
  development server. Serve `create_app(config)` with a threaded WSGI server
  instead; each open `/api/events` stream holds one thread.
- **Restrict the readiness route** to your admins; it describes your account.
- **Run behind HTTPS.** Browsers only allow the microphone on HTTPS pages (and
  `localhost`).
- **Keep secrets in a secret manager**, not a `.env` file on the server.
- **Check the rate limit fits.** The token route and sign-in are limited per
  process (per Gunicorn worker); use a shared limiter on several instances
  (`docs/providers/ratelimit.md`).
- **Store webhook events durably** (your database or a queue) before you answer,
  and de-duplicate on `event_id` there. The in-memory store here forgets
  everything on restart and is per process.
- **Use one stable `DROPCOWBOY_SITE_ID`** per deployment.
- **Never set `DC_AUTH_MODE=mcp-session`** outside your own machine.
