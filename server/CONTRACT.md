# Starter CRM server contract

This file is the source of truth for the Starter CRM server. Every
implementation (`node/`, `python/`, or your own port) must behave exactly as
described here, and must pass the suite in [`conformance/`](conformance/).
The front-ends only ever talk to these routes, so they work unchanged on any
server that passes.

Keywords: **must** is required and tested; **should** is recommended.

## Why the starter has a server at all

1. **Minting site tokens.** A site token is minted with your Drop Cowboy API
   key. The key must never reach a browser, so in `server` mode your backend
   mints a short-lived token for the signed-in user and hands the browser only
   the token. In `login` mode the browser signs in with Drop Cowboy instead,
   but it still asks this server to mint: the mint endpoint is first-party
   only, and Drop Cowboy does not let a page on your origin read its response.
   The browser only ever talks to the routes in this contract.
2. **Receiving webhooks.** Drop Cowboy tells you about inbound texts and call
   outcomes by POSTing signed webhooks. Something you run has to verify them
   and keep your own records in sync.

## Configuration

Read from environment variables. Implementations must load
`<starter root>/.env` (the folder holding `.env.example`). Variables already set
in the process environment win over the file.

| Variable | Default | Notes |
|---|---|---|
| `DC_AUTH_MODE` | `server` | `server`, `mcp-session` or `login`. Anything else fails at boot. |
| `DROPCOWBOY_API_KEY` | none | Required in `server` mode, unused in the others. Secret. |
| `DROPCOWBOY_API_SECRET` | none | Required in `server` mode, unused in the others. Secret. |
| `DROPCOWBOY_SITE_ID` | none | Required in `server` and `login` modes, the two that mint. Whenever it is set, in any mode, it must be a UUID (any version); Drop Cowboy rejects any other `site_id` with `400 invalid_site_id`. One stable value per deployed app. |
| `DROPCOWBOY_WEBHOOK_SECRET` | none | Signing secret, or a comma-separated list of them. Drop Cowboy issues one secret per webhook (an account can hold many, each carrying any set of event types), and a new one only when you rotate it. Without it, webhooks are refused with `503`. Secret. |
| `DROPCOWBOY_API_BASE` | `https://api-v2.dropcowboy.com` | No trailing slash. Must be `http(s)`. |
| `AUTH0_DOMAIN` | `login.dropcowboy.com` | Used by `login` mode in the browser. |
| `AUTH0_CLIENT_ID` | empty | Public SPA client id. Not a secret. |
| `AUTH0_AUDIENCE` | `https://api-v2.dropcowboy.com` | |
| `DC_CDN_VERSION` | empty | Pins the widget CDN version the browser loads. Empty means the front-end's own default. |
| `STARTER_CRM_USER_ID` | none | Required in `server` mode, and must be a UUID. Stands in for your signed-in user (see `requireUser()`). |
| `HOST` | `127.0.0.1` | Loopback by default. |
| `PORT` | `8080` | |

Two optional variables exist so tests can run without touching your files:

| Variable | Default | Notes |
|---|---|---|
| `STARTER_CRM_ROOT` | the starter folder | Where `.env`, `.dropcowboy/session.json`, `shared/`, `vanilla/` and `react/dist/` are looked up. Read from the real environment only, never from `.env`. |
| `DROPCOWBOY_TIMEOUT_MS` | `10000` | Timeout for every call to Drop Cowboy. |

### Boot

- In `server` mode, a missing or invalid `DROPCOWBOY_API_KEY`,
  `DROPCOWBOY_API_SECRET`, `DROPCOWBOY_SITE_ID` or `STARTER_CRM_USER_ID` must stop the
  process with a non-zero exit code and a message that names every missing
  variable. No secret value may appear in that message.
- In `login` mode, a missing `DROPCOWBOY_SITE_ID` must stop the process the
  same way. Nothing else is required: the API key, secret and
  `STARTER_CRM_USER_ID` are not used, and the message must not ask for them.
- A `DROPCOWBOY_SITE_ID` that is set but is not a UUID must stop the process the
  same way in every mode, with a message that names the variable and says it
  must be a UUID.
- An unknown `DC_AUTH_MODE` must stop the process the same way.
- Secrets (API key, API secret, webhook secret), site tokens and login-mode
  access tokens must never be written to stdout, stderr or any log, at boot or
  later.

## Error envelope

Every error response from every route, including unknown routes, is JSON:

```json
{ "error": { "code": "invalid_purpose", "message": "purpose must be one of: session, contacts, campaigns, phone" } }
```

- `code` is a stable machine string. `message` is plain language for a human.
- Nothing else is in the body. Raw upstream bodies are never echoed back.

### Codes the server produces itself

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_json` | The request body is not valid JSON. |
| 400 | `invalid_purpose` | `purpose` is missing or not in the allowlist. |
| 401 | `login_required` | `login` mode: the token or readiness route was called without a well-formed `Authorization: Bearer <access token>`. The front-end should sign the user in. |
| 401 | `login_expired` | `login` mode: Drop Cowboy answered `401` to the user's access token. Their sign-in expired or was revoked; the front-end should sign in again and retry. |
| 401 | `missing_signature` | A webhook arrived without `X-Signature` or `X-Timestamp`. |
| 401 | `stale_timestamp` | `X-Timestamp` is not epoch seconds, or is more than 300 s from now. |
| 401 | `invalid_signature` | The HMAC does not match, or `X-Signature-Version` is not `v1`. |
| 403 | `loopback_only` | `/__dev/session` was called from a non-loopback peer or with a non-loopback `Host`. |
| 404 | `not_found` | No such route, including routes not registered in the current mode. |
| 404 | `session_not_found` | `.dropcowboy/session.json` does not exist. |
| 410 | `session_expired` | The session file's `expires_at` is in the past. |
| 413 | `payload_too_large` | A request body is over 1 MB. |
| 500 | `session_invalid` | The session file is not valid JSON, or lacks a string `token` and an epoch-millisecond `expires_at`. |
| 500 | `internal_error` | Anything unexpected. |
| 502 | `upstream_auth_failed` | `server` mode: Drop Cowboy answered `401` to this server's API key. The server's credentials are wrong, not the browser's, so this is deliberately not passed through as `401`: signing in again would not help. |
| 502 | `upstream_error` | Drop Cowboy answered `5xx`, or a success that is not the documented shape. |
| 502 | `upstream_unreachable` | The request to Drop Cowboy failed (DNS, connection refused, TLS). |
| 503 | `webhook_not_configured` | `DROPCOWBOY_WEBHOOK_SECRET` is not set. |
| 504 | `upstream_timeout` | Drop Cowboy did not answer within `DROPCOWBOY_TIMEOUT_MS`. |

### Passing through Drop Cowboy errors

When Drop Cowboy answers a proxied call with a `4xx` other than `401`, the
server answers with **the same status** and **the upstream code, unchanged**,
so a front-end can map `payment-required`, `consent_required`,
`insufficient-scope`, `byoc_required` and so on the same way on any server.

Drop Cowboy errors come in two shapes:

```json
{ "type": "https://api-v2.dropcowboy.com/errors/payment-required", "title": "Payment Required", "status": 402, "detail": "Add funds to continue." }
```

```json
{ "message": "A valid consent_id is required for this embed send", "detail": { "code": "consent_required" } }
```

Derive `code` from the first of these that is a non-empty string:

1. `detail.code` (when `detail` is an object)
2. `details.code`
3. `code`
4. `error`
5. the last path segment of `type`
6. a default for the status: `400 bad-request`, `402 payment-required`,
   `403 forbidden`, `404 not-found`, `409 conflict`, `422 unprocessable-entity`,
   `429 too-many-requests`, any other `4xx` `bad-request`

Derive `message` from `detail` (when it is a string), then `message`, then
`title`, else a generic sentence. Cap it at 300 characters. For `429`, copy the
upstream `Retry-After` header when present.

`5xx` answers never pass through: they become `502 upstream_error` with a
generic message.

## Routes

All JSON responses use `Content-Type: application/json`.

### `GET /healthz`

All modes. `200 {"ok": true}`.

### `GET /api/config`

All modes. Public runtime config for the browser. It must never contain a
secret.

```json
{
  "auth_mode": "login",
  "site_id": "3f8a2c1e-9b4d-4e7a-8c2f-1d5e6a7b8c9d",
  "api_base": "https://api-v2.dropcowboy.com",
  "cdn_version": null,
  "auth0": {
    "domain": "login.dropcowboy.com",
    "client_id": null,
    "audience": "https://api-v2.dropcowboy.com"
  }
}
```

- `site_id` and `cdn_version` are `null` when unset.
- `auth0` is an object only when `auth_mode` is `login`, otherwise `null`.
  Its `client_id` is `null` when `AUTH0_CLIENT_ID` is empty.

### `POST /api/dropcowboy/token`

Registered in `server` and `login` modes; `404 not_found` in `mcp-session`.

The two modes differ only in who the caller is and which credential goes to
Drop Cowboy:

| | `server` | `login` |
|---|---|---|
| Caller | `requireUser()`, a placeholder for your own authentication that the starter marks *REPLACE WITH YOUR AUTH*. It returns `STARTER_CRM_USER_ID` as the signed-in user. | The browser, signed in with Drop Cowboy, sending `Authorization: Bearer <access token>` |
| Credential sent upstream | `x-key` and `x-secret` | The browser's access token as `Authorization: Bearer <token>`, and no `x-key` or `x-secret` |
| `sub` sent upstream | `requireUser().id` | None |
| Drop Cowboy answers `401` | `502 upstream_auth_failed` | `401 login_expired` |

#### Login mode

- The access token is the Auth0 access token from "Sign in with Drop Cowboy"
  (the `auth0` settings in `/api/config`). It stands for the user, so
  `requireUser()` is not used on this route in `login` mode.
- `Authorization` must be the scheme `Bearer` (any case), one or more spaces,
  then a single token of `A-Z a-z 0-9 - . _ ~ + /` optionally followed by `=`
  padding (RFC 6750), and nothing else. Anything else, including no header, is
  `401 login_required`. This is checked before the body is read, and Drop
  Cowboy is not called.
- The server does **not** verify the token. It forwards it, always spelled
  `Bearer <token>`, and Drop Cowboy verifies it and decides whether this user
  may mint. A user without that permission gets `403 insufficient-scope`,
  passed through as usual.
- No `sub` is sent, so the minted token has none. Drop Cowboy already knows
  the account from the access token, and a `sub` taken from the browser would
  be an attribution claim nobody checked.
- A `401` from Drop Cowboy means the user's sign-in expired or was revoked, so
  the server answers `401 login_expired` and the front-end signs in again. In
  `server` mode the same `401` means this server's API key is wrong, which no
  browser can fix, so it stays `502 upstream_auth_failed`.
- The access token is a secret like the API key: it is never logged and never
  appears in a response.

#### Request

```json
{ "purpose": "session" }
```

The server maps `purpose` to scopes. **The browser can never choose scopes.**
Every other field in the body (`scope`, `sub`, `site_id`, `ttl_seconds`, ...)
is ignored, in both modes.

| `purpose` | Scopes | Used by |
|---|---|---|
| `session` | `["dialer:webrtc", "contacts"]` | The Dock: dialer, messenger, inbox and their contact panes |
| `contacts` | `["contacts"]` | The Contacts, Contact and Pipeline pages: contact REST calls, `dc-contact-card`, `dc-pipeline-board` |
| `campaigns` | `["campaigns"]` | The Campaigns page |
| `phone` | `["phone:hub"]` | The Phone page |

The lookup must be an own-key lookup: `constructor`, `__proto__`,
`toString` and similar are `400 invalid_purpose`. The `invalid_purpose`
message lists every purpose, in the order above.

Each purpose asks for the least its pages need. Drop Cowboy checks for a
connected carrier and a balance only when the scopes include `dialer:webrtc`
or `phone:hub`, so a `contacts` token mints for a team that has neither, and
the contacts pages keep working while the Dock shows why calling is not
available yet.

In `mcp-session` mode there is no mint route. Every page, the contacts pages
included, reuses the one token the MCP wrote to `.dropcowboy/session.json`,
with whatever scopes the MCP minted it with.

Upstream call in `server` mode:

```
POST {DROPCOWBOY_API_BASE}/phone/public/embed/token
x-key: {DROPCOWBOY_API_KEY}
x-secret: {DROPCOWBOY_API_SECRET}
Content-Type: application/json

{ "site_id": "{DROPCOWBOY_SITE_ID}", "sub": "{requireUser().id}", "scope": [...], "ttl_seconds": 900 }
```

Upstream call in `login` mode:

```
POST {DROPCOWBOY_API_BASE}/phone/public/embed/token
Authorization: Bearer {the browser's access token}
Content-Type: application/json

{ "site_id": "{DROPCOWBOY_SITE_ID}", "scope": [...], "ttl_seconds": 900 }
```

Neither call follows redirects, which would resend the credential elsewhere.

Upstream success is `{"data": {"token", "expires_at", ...}}`, where
`expires_at` is epoch milliseconds. Extra keys in the upstream body are
ignored.

Response `200`, with `Cache-Control: no-store`, and exactly these two keys:

```json
{ "token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...", "expires_at": 1790000000000 }
```

An upstream success without a string `token` and a numeric `expires_at` is
`502 upstream_error`.

When the mint refuses, the error carries `details.code`. The
[pass-through rules](#passing-through-drop-cowboy-errors) forward these codes
unchanged:

| Status | Code | When |
|---|---|---|
| `400` | `invalid_site_id` | `DROPCOWBOY_SITE_ID` is not a UUID |
| `402` | `insufficient_balance` | `session` or `phone`, with no allotment and no balance. Never `contacts` or `campaigns`. |
| `403` | `byoc_required` | `session` or `phone`, without a connected carrier. Never `contacts` or `campaigns`. |
| `403` | `site_token_not_allowed` | The mint was called with a site token. In `server` mode it can't happen, because the server mints with its API key; in `login` mode it means the browser sent a site token where its access token belongs. |

### `GET /api/dropcowboy/readiness`

Registered in `server` and `login` modes; `404 not_found` in `mcp-session`.
The caller and the credential work exactly as on the
[token route](#post-apidropcowboytoken): `requireUser()` and `x-key`/`x-secret`
in `server` mode; the browser's `Authorization: Bearer <access token>`,
forwarded as is, in `login` mode, with the same `401 login_required` and
`401 login_expired`.

Upstream call: `GET {DROPCOWBOY_API_BASE}/register/public/integration-readiness`.
Drop Cowboy accepts either credential there. It needs `balance:read`: as a
scope on the API key, or as a permission of the signed-in user.

Response `200`, `Cache-Control: no-store`, containing only these fields
(anything else upstream sends, such as pool ids, plan ids, phone number lists or
integration ids, is dropped):

```json
{
  "embed_ready": false,
  "next_actions": ["connect_byoc", "add_funds"],
  "building_blocks_enabled": true,
  "byoc": {
    "connected": false,
    "providers": [{ "provider": "twilio", "enabled": true, "default": true }]
  },
  "funds": { "available": 0, "funds_ok": false },
  "allotment": { "sms": { "remaining": 100, "cap": 100 } },
  "numbers": { "count": 0 },
  "embed_resolve_contact_consent": false
}
```

- Booleans default to `false`, numbers to `0`, `next_actions` and `providers`
  to `[]` when upstream omits them.
- `allotment` keeps every key whose value has numeric `remaining` and `cap`,
  and only those two fields.
- `embed_resolve_contact_consent` is the team setting that lets embed texts and
  calls use consent already on the contact. It is off by default.

### `GET /__dev/session`

Registered only in `mcp-session` mode. Development only.

An AI agent using the Drop Cowboy MCP mints a site token and writes it to
`<starter root>/.dropcowboy/session.json`:

```json
{ "token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...", "expires_at": 1790000000000, "site_id": "3f8a2c1e-9b4d-4e7a-8c2f-1d5e6a7b8c9d" }
```

The server re-reads the file on every request.

| Check | Result |
|---|---|
| Peer address is not loopback (`127.0.0.0/8`, `::1`, `::ffff:127.x.x.x`) | `403 loopback_only` |
| `Host` header hostname is not `localhost`, `127.0.0.1` or `[::1]` | `403 loopback_only` |
| File missing | `404 session_not_found`, with a message telling the developer how to create it |
| Not JSON, `token` not a non-empty string, or `expires_at` not a number `>= 1e12` (epoch ms) | `500 session_invalid` |
| `expires_at <= now` | `410 session_expired` |
| Otherwise | `200 {"token", "expires_at", "site_id"}` with `Cache-Control: no-store` |

- The peer address is the TCP socket's remote address. `X-Forwarded-For`,
  `Forwarded` and `X-Real-IP` must be ignored: anyone can send them.
- The `Host` check stops DNS rebinding, where a hostile page resolves its own
  name to `127.0.0.1` to read the token from the developer's machine.
- `site_id` is the file's value, else `DROPCOWBOY_SITE_ID`, else `null`.

### `POST /webhooks/dropcowboy`

All modes. Verifies a Drop Cowboy webhook delivery.

Headers sent by Drop Cowboy:

| Header | Value |
|---|---|
| `X-Signature` | `sha256=<hex digest>` |
| `X-Timestamp` | Unix time in seconds when the delivery was signed |
| `X-Signature-Version` | `v1` |
| `X-Event-Id` | The event's `event_id`. The same on every retry. |
| `X-Attempt` | `1`, `2` or `3` |

Verification, in this order:

1. `DROPCOWBOY_WEBHOOK_SECRET` unset: `503 webhook_not_configured`.
2. `X-Signature` or `X-Timestamp` missing or empty: `401 missing_signature`.
3. `X-Signature-Version` present and not `v1`: `401 invalid_signature`.
4. `X-Timestamp` not all digits, or `|now - X-Timestamp| > 300` seconds:
   `401 stale_timestamp`.
5. For each configured secret,
   `expected = "sha256=" + hex(HMAC_SHA256(key = secret, message = X-Timestamp + "." + raw_body))`,
   compared to `X-Signature` in constant time. The secret is used as its UTF-8
   bytes. No match for any secret: `401 invalid_signature`.
6. Parse the body as JSON. Failure: `400 invalid_json`.
7. The event id is `X-Event-Id`, else the body's `event_id`. If it was already
   accepted: `200 {"received": true, "duplicate": true}`, and the event is not
   stored or pushed again.
8. Store the event, push it to `/api/events`, answer `200 {"received": true}`.

- **Sign over the raw bytes received.** Parsing and re-serializing the JSON
  can change spacing and key order, and then no signature matches. Any
  framework JSON body parser must be kept off this route.
- Answer within a few seconds. Drop Cowboy waits 5 s, then retries `408`, `429`
  and `5xx` about 1 and 5 minutes later. It does not retry other `4xx`.
- Accept any `Content-Type`. Bodies up to 1 MB.
- The starter keeps events and seen ids in memory, bounded (the Node server
  keeps 200 events and 1,000 ids). A real CRM stores them durably.

Stored event, as pushed to `/api/events`:

```json
{
  "event_id": "d1f3a8e2-7c4b-4f9a-9d22-9c1e2f3a4b5c",
  "event": "contact.rvm.status",
  "event_at": 1774041600000,
  "received_at": 1774041601234,
  "attempt": 1,
  "data": { "contact_id": "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d", "status": "success" }
}
```

`event` and `event_at` are `null` and `data` is `{}` when absent. `attempt` is
`X-Attempt` as an integer, else `1`. `received_at` is epoch milliseconds.

### `GET /api/events`

All modes. Protected by `requireUser()`. A Server-Sent Events stream of
verified webhook events.

- `Content-Type: text/event-stream`, `Cache-Control: no-cache`.
- On connect, the server replays buffered events oldest first. If the client
  sends `Last-Event-ID` and that id is still buffered, only later events are
  replayed.
- After the replay, even an empty one, the server sends one named event,
  `event: replayed` with `data: {}`. It marks where history ends and live
  events begin, so a freshly loaded page can list what it missed without
  announcing each item as new. Being named, it never reaches `onmessage`.
- Each event is one SSE message with the default event type, so the browser's
  `EventSource.onmessage` receives it:

  ```
  id: d1f3a8e2-7c4b-4f9a-9d22-9c1e2f3a4b5c
  data: {"event_id":"d1f3a8e2-...","event":"contact.rvm.status",...}

  ```

- The server should send a comment line (`: keepalive`) at least every 30 s.

### Static files

All modes. `GET` requests outside `/api/`, `/__dev/`, `/webhooks/` and
`/healthz`:

| Path | Served from | If that folder has no `index.html` |
|---|---|---|
| `/shared/...` | `<root>/shared/` | Not applicable: see [shared modules](#shared-modules) |
| `/react/...` | `<root>/react/dist/` | `200 text/plain` explaining how to build or run the React app |
| everything else | `<root>/vanilla/` | `200 text/plain` explaining how to start a front-end |

When the folder has an `index.html`, a path with no matching file and an `Accept` header that
includes `text/html` gets that folder's `index.html`, so client-side routes such
as `/setup` and `/contacts/5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d` survive a reload.
Anything else that matches nothing is `404 not_found` in the error envelope.

No path may ever serve a file outside its folder, and names starting with `.`
(such as `.env`) are never served.

#### Shared modules

`<root>/shared/` holds ES modules the front-ends share. The vanilla front-end
has no build step, so the browser imports them straight from `/shared/...`.

- A regular file inside `<root>/shared/` is served `200`. `.js` and `.mjs`
  files are `Content-Type: text/javascript` (a charset parameter may follow);
  browsers refuse to run a module served as anything else.
- Files only. There is no `index.html`, no directory listing and no
  client-route fallback, even for an `Accept: text/html` request. `/shared`,
  `/shared/`, any folder, a missing file and a dotfile are all
  `404 not_found` in the error envelope, so a broken import fails loudly.
- A path that would leave the folder is `404 not_found`: `..` segments, raw or
  percent-encoded (`%2e%2e`, `..%2f`). So is any path containing a backslash,
  raw or encoded as `%5c`. A backslash is a separator only on Windows, so
  refusing it everywhere keeps one URL meaning one thing on every machine.
- Served in every mode. A missing `<root>/shared/` folder just means every
  `/shared/...` path is `404 not_found`.

## Running the conformance suite

See [`conformance/README.md`](conformance/README.md). In short:

```bash
cd server/conformance
node run.js                                                   # the Node server
SERVER_CMD="python -m starter_crm" SERVER_CWD=../python node run.js   # the Python server
```
