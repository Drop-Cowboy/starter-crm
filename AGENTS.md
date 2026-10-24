# AGENTS.md

Instructions for AI agents that change this starter, or copy it to build a CRM
on Drop Cowboy Building Blocks. Read [`docs/how-it-works.md`](docs/how-it-works.md)
first for how the parts fit, what each page does and which token it uses, and
[`server/CONTRACT.md`](server/CONTRACT.md) before touching a server route.

The person you're working with may not write code. Explain each change in
plain words, say which files you changed, and run `npm test` before you call
it done. Never ask them to paste an API key, secret or passcode into the chat:
`npm run setup` and the host's settings page are where those go. When
something fails, check [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) first; its
"Start here" section covers what people usually hit. Copy-paste recipes for
common requests are in [`docs/build-with-ai.md`](docs/build-with-ai.md), and
webhook setup is in [`docs/webhooks.md`](docs/webhooks.md).

## Floors

- **Node 24+** (`engines.node` in every package.json). Run
  `source ~/.nvm/nvm.sh && nvm use 24` in cloud shells that default to 22.
- **Python 3.11+** for the Flask server and its venv.

## Comments (teaching code)

This starter is teaching code for junior developers and AI-assisted builders.
It carries **verbose comments**. Do not strip them to match sparse-comment
defaults used elsewhere in Drop Cowboy.

- Every source file opens with a header: what it does, where it sits in the
  request flow, which CONTRACT section it implements, and what a customer
  would change instead of editing the file.
- Every non-obvious branch, env var and error path explains *why*.
- Env vars document meaning, default, allowed values and failure mode where
  they are read; the same text feeds `.env.example`.
- Tests say what behavior each case protects and which contract rule it checks.
- Every export has JSDoc (Node) or a Google-style docstring (Python): purpose,
  parameters, return value, the errors it raises with their envelope codes, and
  side effects. `eslint-plugin-jsdoc` and Ruff's `D` rules enforce this in
  `npm test` (stages `lint:node` and `lint:python`).
- Never delete a comment without replacing what it explained, and change the
  comment in the same diff as the code it describes.

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
    this folder. Never vendor, bundle or commit Building Blocks code here.
12. **No `SAMPLE_*` names.** Only `STARTER_CRM_*`. A set `SAMPLE_USER_ID` or
    `SAMPLE_CRM_ROOT` is a structured boot problem (`renamed_env`).
13. **Providers never see a secret in a log, and never throw for a bad
    credential.** Redaction runs before a log provider; an identity returns
    `null` for a bad credential and throws only when the identity system is
    down. A hook or observer must never change a response.
14. **Await every async call** in server and serverless code. No
    fire-and-forget, no `waitUntil`.
15. **IDs and fiction.** Plain UUIDs only. Fictional data: contacts get 555
    test numbers (+1 555 XXX XXXX, `shared/sandbox.js`), whose last four
    digits pick what a call does, so dialing one never rings a phone; a
    team's own business numbers stay in the 555-01xx range of a real area
    code. Emails are `example.com` / `example.org`. No secrets, real customer data,
    internal hostnames, AWS account ids/ARNs or internal service names.

## Where things live

| To change | Edit |
|---|---|
| The CRM's name, logo or colours | `--crm-brand`, `--crm-brand-hover` and `--crm-brand-soft` under "Rebrand here" in `shared/crm.css` (light and dark); the name and logo in `vanilla/index.html` and `react/src/components/Layout.jsx`, plus the page titles that search for `Starter CRM` finds. See "Common changes" in `CUSTOMIZE.md`. |
| Which scopes a purpose gets | `PURPOSE_SCOPES` in `server/node/src/token.js` and its Python twin in `server/python/starter_crm/token.py`, plus `server/CONTRACT.md` |
| Who the user is | Choose `DC_IDENTITY` (`dev`, `passcode`, `oidc`) or write a provider; `requireUser()` in `server/node/src/auth.js` and `require_user()` in `server/python/starter_crm/auth.py` only call it. See `docs/providers/identity.md`. |
| A replaceable piece (identity, secrets, rate limit, log, observer) | A provider file in `server/node/src/providers/<kind>/` and `server/python/starter_crm/providers/<kind>/`, registered in each `providers/index.js` or `__init__.py`. Document it in `docs/providers/<kind>.md` and check it with `npm run conformance:provider`. |
| A secret manager provider (`doppler`, `infisical`, `vault`, `1password`) | `server/node/src/providers/secrets/` and `server/python/starter_crm/providers/secrets/`. The HTTP ones share `http.js` and `_http.py` (https-only, no redirects, 10 s timeout, no body in errors); keep that behaviour in a new one. Test it against a stand-in in `server/conformance/lib/secret-managers.js` and suite 19. |
| Passcode sign-in and the auth header in the browser | `shared/identity.js`, `shared/server-api.js` (`setAuthHeaderProvider`), `shared/fetch-event-source.js`, `vanilla/sign-in.js`, `react/src/components/SignIn.jsx` |
| Webhook verification | `server/node/src/webhooks.js`, `server/python/starter_crm/webhooks.py` |
| How the browser gets and reuses tokens | `shared/token-provider.js` |
| Contacts REST calls | `shared/contacts-api.js` |
| The Dock and the contacts bundle | `startDock()` and `startContacts()` in `shared/crm.js` |
| Handing tokens to widgets, Call and Text | `shared/widgets.js` |
| CDN release and SRI loading | `shared/config.js` (`DEFAULT_CDN_VERSION`), `shared/dropcowboy-cdn.js` |
| Error messages | `GUIDANCE` and `CONSENT_REASONS` in `shared/errors.js` |
| The setup checklist | `shared/setup.js` |
| A page | `vanilla/pages/*.js` and `react/src/pages/*.jsx`. Change both. |
| A feature of the customer's own (a screen with data) | A module: `npm run new:module -- <id>`, then `server/node/src/modules/<id>/`, `server/python/starter_crm/modules/<id>.py`, `server/schemas/<id>.json`, a page in both front-ends, and a branch for its id in `vanilla/pages/module.js` and `react/src/pages/ModulePage.jsx` (without it the placeholder shows). Never in `core`, `auth` or the webhook code. Deals is the example; see `CUSTOMIZE.md`, "Add a module". |
| A custom provider, observer or handlers file | Under `server/node/src/` (or `server/python/starter_crm/`), with the setting pointing there (`DC_OBSERVER=./server/node/src/my-observer.js`). A file at the starter root is left out of the Docker images and cannot import packages installed in `server/node`. |
| The AWS template and its scripts | `deploy/aws/ecs-express.yaml` (plain CloudFormation, no CDK), `scripts/deploy-aws.mjs`, `scripts/destroy-aws.mjs`, `scripts/lib/aws-stack.mjs`. The DynamoDB table in the template must equal `TABLE_SPEC` in `server/node/src/aws.js` and `aws_util.py`; `scripts/aws-template.test.mjs` checks it with cfn-lint. Nothing here may call AWS in a test: hand `deploy` and `destroy` a fake `exec`. |
| The Vercel (Next.js) variant | `server/nextjs`: route files under `app/`, `lib/core.js` (boots the Node core once per instance, never starts a loop), `scripts/serve.mjs` (the long-running launcher the test suites use). The core stays in `server/node/src`; never copy it into the variant, and never leave work running after the response (a function is frozen when it ends). Webhook modes `vercel-queue` and `qstash` are in `server/node/src/providers/webhooks/` and the Python `qstash`; the platform guards are in `config.js` and `config.py`. |
| The Netlify variant | `server/netlify`: `functions/api.mjs` (every path the CDN has no file for), `functions/webhook-jobs.mjs` (the Async Workloads workload), `functions/maintenance.mjs` (scheduled), `lib/core.js`, `scripts/build.mjs` (`dist/` and `_headers`), `scripts/serve.mjs` (the launcher the test suites use), and `netlify.toml` at the root. Same rules as the Next.js variant: the core stays in `server/node/src`, and nothing runs after the response (`waitUntil` is not used). The webhook mode is `netlify-async` in `server/node/src/providers/webhooks/`; the Python server refuses it. A file the server reads from outside `server/node` must be in `netlify.toml`'s `included_files`. |
| Where modules keep data | `DC_DATA`; the providers in `server/node/src/providers/data/` and `server/python/starter_crm/providers/data/`, `docs/providers/data.md`, migration `server/migrations/*/002_module_data.sql`. |
| What a module route accepts | A JSON schema in `server/schemas/`, read by both `validate.js` and `validate.py`. Add a case to `server/conformance/provider/schema-vectors.json` for a new keyword. |
| A widget wrapper in React | `react/src/blocks/` |

The two servers must stay interchangeable: a change to one is a change to
`server/CONTRACT.md`, to the other server, and to the conformance suite in
`server/conformance/suite/`.

## Verify

Run what covers your change before you call it done:

```bash
source ~/.nvm/nvm.sh && nvm use 24   # if the shell is still on Node 22
npm test                            # every stage, including leaks
npm run test:leaks                  # leak checks alone
npm run test:live                   # real API; needs STARTER_CRM_LIVE_* secrets
npm run doctor                      # config + reachability + self-webhook
```

`npm test` from the starter root runs every stage, including the leak checks.
Per-package suites still work (`shared`, `server/node`, `server/python`,
`server/conformance`, `react`, `tests/e2e`) when you are iterating.

## Common mistakes and their symptoms

| Mistake | Symptom |
|---|---|
| Minting with scopes from the request body | Any page can ask for `phone:hub` and rent numbers. The conformance suite fails `02-token`. |
| One `session` token for every page | The contacts pages fail with `byoc_required` or `insufficient_balance` for a team that has not set up calling. |
| Passing the token as an attribute (`<dc-contact-card token="...">`) | The token shows in the DOM and devtools. The widget never signs in. |
| Rendering a React element before its bundle defines it | React sets attributes instead of properties, so `tokenManager` never arrives. Wait for `useContactWidgets()` or `useSessionWidgets()`. |
| `getToken` that returns the remembered token | Widgets keep sending an expired token, then fire `dc-session-expired`. Use `tokens.refresh()`, not `tokens.get()`. |
| `dock.dial('+15550100001')` with no `contact_id` | The call is not logged on the contact, and "Use existing contact consent" cannot apply, so texts fail with `consent_required`. |
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
