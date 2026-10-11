# AGENTS.md

Instructions for AI agents that change this starter, or copy it to build a CRM
on Drop Cowboy Building Blocks. Read [`README.md`](README.md) first for what
each page does, and [`server/CONTRACT.md`](server/CONTRACT.md) before touching
a server route.

## Invariants

Break any of these and the starter is no longer a safe reference.

1. **No API key in the browser.** `DROPCOWBOY_API_KEY` and
   `DROPCOWBOY_API_SECRET` are read only by the server. Nothing in `shared/`,
   `vanilla/` or `react/` may reference them, and `publicConfig()` in
   `server/node/src/app.js` must never return a secret.
2. **Mint per purpose, on the server.** The browser sends `{ purpose }` to
   `POST /api/dropcowboy/token`. The server maps it to scopes with an own-key
   lookup (`PURPOSE_SCOPES` in `server/node/src/token.js`) and ignores any
   `scope`, `sub`, `site_id` or `ttl_seconds` in the body. Never add a route
   that lets the browser pick scopes.

   | Purpose | Scopes |
   |---|---|
   | `session` | `["dialer:webrtc", "contacts"]` |
   | `contacts` | `["contacts"]` |
   | `campaigns` | `["campaigns"]` |
   | `phone` | `["phone:hub"]` |

3. **Tokens never go in a URL, in storage or in a log.** Not in a query
   string, a hash, an `src`, `localStorage`, `sessionStorage`, a cookie or a
   console line. Widgets get them as JavaScript properties only:
   `init({ token, expires_at, getToken })` or `el.tokenManager = ...`. The
   server answers token routes with `Cache-Control: no-store`.
4. **IDs are raw UUIDs.** `site_id`, `sub`, contact ids, event ids. No type
   prefixes. In examples, use values such as
   `5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d`, and generate real ones with
   `crypto.randomUUID()`.
5. **Pass `contact_id` with every call and text.** Hand The Dock
   `{ contact_id, phone }` (see `dockTarget()` in `shared/widgets.js`), never
   just a phone number. Drop Cowboy then logs the activity on that contact,
   and the team's "Use existing contact consent" setting can apply.
6. **Handle `consent_required`.** Texts and calls to US numbers are refused
   with `consent_required` and a `detail.reason` unless the send has a
   `consent_id`, or the team turned on "Use existing contact consent" and the
   send has `contact_id`. Show the reason with `consentMessage()`; never retry
   around it. Opt-outs, STOP replies and Do Not Call always block.
7. **Refresh through `getToken`.** Every `init()` gets a `getToken` that calls
   `tokens.refresh(purpose)`. Widgets call it before the token expires and
   once after a `401`, and fire `dc-session-expired` when it fails. REST calls
   in `shared/contacts-api.js` retry exactly once after a `401`. Never extend
   a token's lifetime past what the server minted (900 s here, 3600 s at most).
8. **Load bundles from a pinned release with SRI.** Use `createCdnLoader()` in
   `shared/dropcowboy-cdn.js`. Never load from `/latest/`, and never inject a
   script without `integrity` and `crossorigin="anonymous"`.
9. **Set `window.DropCowboy.confirmSpend = true` before any bundle loads.**
   `startCrm()` does it first. Keep the `phone` token on the Phone page.
10. **Verify webhooks on the raw body.** `express.raw` (or
    `request.get_data()`) on `/webhooks/dropcowboy`, with no JSON parser in
    front of it.
11. **Copy, don't install.** Building Blocks load from the CDN at runtime.
    There is no npm package to install, and no Drop Cowboy source belongs in
    this folder.

## Where things live

| To change | Edit |
|---|---|
| Which scopes a purpose gets | `PURPOSE_SCOPES` in `server/node/src/token.js` and its Python twin in `server/python/starter_crm/token.py`, plus `server/CONTRACT.md` |
| Your authentication | `requireUser()` in `server/node/src/auth.js`, `require_user()` in `server/python/starter_crm/auth.py` |
| Webhook verification | `server/node/src/webhooks.js`, `server/python/starter_crm/webhooks.py` |
| How the browser gets and reuses tokens | `shared/token-provider.js` |
| Contacts REST calls | `shared/contacts-api.js` |
| The Dock and the contacts bundle | `startDock()` and `startContacts()` in `shared/crm.js` |
| Handing tokens to widgets, Call and Text | `shared/widgets.js` |
| CDN release and SRI loading | `shared/config.js` (`DEFAULT_CDN_VERSION`), `shared/dropcowboy-cdn.js` |
| Error messages | `GUIDANCE` and `CONSENT_REASONS` in `shared/errors.js` |
| The setup checklist | `shared/setup.js` |
| A page | `vanilla/pages/*.js` and `react/src/pages/*.jsx`. Change both. |
| A widget wrapper in React | `react/src/blocks/` |

The two servers must stay interchangeable: a change to one is a change to
`server/CONTRACT.md`, to the other server, and to the conformance suite in
`server/conformance/suite/`.

## Verify

Run what covers your change before you call it done:

```bash
cd shared && npm test
cd server/node && npm test && npm run lint
cd server/python && pytest && ruff check .
cd server/conformance && npm run test:node && npm run test:python
cd react && npm test && npm run lint && npm run build
cd tests/e2e && npm test        # Playwright, both front-ends, fake Drop Cowboy
npm run test:leaks              # from the starter root: no secrets, no internal hosts
```

`npm test` from the starter root runs every stage, including the leak checks.

## Common mistakes and their symptoms

| Mistake | Symptom |
|---|---|
| Minting with scopes from the request body | Any page can ask for `phone:hub` and rent numbers. The conformance suite fails `02-token`. |
| One `session` token for every page | The contacts pages fail with `byoc_required` or `insufficient_balance` for a team that has not set up calling. |
| Passing the token as an attribute (`<dc-contact-card token="...">`) | The token shows in the DOM and devtools. The widget never signs in. |
| Rendering a React element before its bundle defines it | React sets attributes instead of properties, so `tokenManager` never arrives. Wait for `useContactWidgets()` or `useSessionWidgets()`. |
| `getToken` that returns the remembered token | Widgets keep sending an expired token, then fire `dc-session-expired`. Use `tokens.refresh()`, not `tokens.get()`. |
| `dock.dial('+15125550142')` with no `contact_id` | The call is not logged on the contact, and "Use existing contact consent" cannot apply, so texts fail with `consent_required`. |
| A JSON body parser in front of the webhook route | Every delivery fails with `invalid_signature`. |
| Only one webhook secret configured | Deliveries for other event types fail with `invalid_signature`. Each webhook has its own secret; list them comma-separated. |
| Loading from `/latest/` or dropping `integrity` | `cdn_unavailable`, or a bundle that can change under you. |
| A new `site_id` per deploy or per environment run | The inbox looks empty: conversations are partitioned by `site_id`. |
| Calling `api-v2.dropcowboy.com` from the browser | CORS errors. The browser calls `app-api-v2.dropcowboy.com`; only the server calls `api-v2`. |
| Binding `HOST=0.0.0.0` in `mcp-session` mode | `/__dev/session` still answers loopback only (`403 loopback_only`), but other machines can reach the rest of the server. |

## Using the Drop Cowboy MCP

The hosted MCP (`https://mcp.dropcowboy.com/mcp`) can take an account from
signup to a running starter. The ordered steps live in one place; ask for them
rather than guessing:

1. Get the **`build_simple_crm`** prompt, or call
   **`get_builder_setup_guide({ goal: "crm" })`** and follow
   `crm_path.steps` in order. Each step names the tool to call. Steps that need
   the human (leaving retail billing, carrier credentials, funds, texting
   registration, the E911 location) stay with the human.
2. Discovery mode hides data tools such as `mint_embed_token`, and most
   clients (Claude included) read the tool list once per connection. Call
   **`describe_tools({ names: ["mint_embed_token"] })`** for the schema, then
   run it with **`call_write_tool`** (`call_read_tool` for read tools). Only a
   client that re-reads the tool list benefits from
   `set_tool_profile({ profile: "full" })` or `activate_tool_domains`.
3. In `get_integration_readiness`, skip the `create_agent` and
   `publish_agent` next actions. A CRM does not need a voice agent.
4. Mint with **`mint_embed_token`**: the app's `site_id`, the least scope the
   page needs, and `ttl_seconds` of at most 3600.

### Session handoff (`mcp-session` mode)

For local development without an API key on disk, mint the session scopes and
hand the token to the starter through a file:

```text
mint_embed_token({
  site_id: "<the app's DROPCOWBOY_SITE_ID>",
  scope: ["dialer:webrtc", "contacts"],
  ttl_seconds: 3600
})
```

Write the result to `.dropcowboy/session.json` in the starter root:

```json
{ "token": "<token>", "expires_at": 1790000000000, "site_id": "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d" }
```

- `expires_at` is epoch milliseconds, copied from the mint result.
- `.dropcowboy/` must stay in `.gitignore`. Never commit, print or paste the
  token anywhere else.
- Set `DC_AUTH_MODE=mcp-session`. The server serves the file only to loopback
  requests with a loopback `Host`, and refuses it once expired
  (`410 session_expired`). Mint again and rewrite the file.
- This mode has one token, so the Campaigns and Phone pages are unavailable.
  Production uses `server` mode, where your server mints with its API key.
