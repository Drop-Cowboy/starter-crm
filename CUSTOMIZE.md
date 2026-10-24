# Customize the starter

Recipes for the changes most teams make first. Apart from the common changes
just below, every recipe changes configuration or adds a file. None needs you
to edit the server's source.

- [Common changes: name, logo and colours](#common-changes)
- [Choose who signs in](#choose-who-signs-in)
- [Sign in with your own identity provider (OIDC)](#sign-in-with-your-own-identity-provider-oidc)
  - [Auth0](#auth0)
  - [Clerk](#clerk)
  - [Supabase Auth](#supabase-auth)
  - [Firebase Authentication](#firebase-authentication)
  - [Auth.js and other cookie sessions](#authjs-and-other-cookie-sessions)
- [Write your own identity](#write-your-own-identity)
- [Send errors to Sentry](#send-errors-to-sentry)
- [Send traces to OpenTelemetry](#send-traces-to-opentelemetry)
- [Read secrets from a vault or mounted files](#read-secrets-from-a-vault-or-mounted-files)
- [Share rate limits across instances](#share-rate-limits-across-instances)
- [Run your own code when a webhook arrives](#run-your-own-code-when-a-webhook-arrives)
- [Keep events in a database](#keep-events-in-a-database)
- [Add a module](#add-a-module)

<a id="common-changes"></a>

## Common changes: name, logo and colours

Each change below is the same in both front-ends. The page at
http://127.0.0.1:8080 is the one in `vanilla/`; the React one is at `/react/`,
once you've built it (`cd react && npm install && npm run build`). Make each
change in `vanilla/`, and in `react/` too if you use it. Not sure? Change
`vanilla/`, and don't delete it unless you've moved to React.

**Colours.** Open `shared/crm.css`. The block marked "Rebrand here" at the top
sets the brand colour:

```css
:root {
    --crm-brand: #2563eb;        /* buttons, links, the logo */
    --crm-brand-hover: #1d4ed8;  /* a button under the pointer */
    --crm-brand-soft: #eaf1fe;   /* light backgrounds, such as the current page */
}
```

Change those three, and `--crm-brand-soft` in the dark-theme block further
down the same file; the other dark-theme brand colours are worked out from
`--crm-brand`. The Drop Cowboy widgets take `--crm-brand` too, so the contact card and The
Dock match. Every other colour is a `--crm-*` setting in the same file.

**Name.** "Starter CRM" appears in the page titles, the top bar and the
sign-in form. Search the project for `Starter CRM` and replace it in
`vanilla/`, `react/` and `shared/`. Then run `npm test`: a few tests check
the old name, and they'll tell you which to update.

**Logo.** The top bar shows an "S" in a coloured square:
`<span class="logo" aria-hidden="true">S</span>`, in `vanilla/index.html` and
`react/src/components/Layout.jsx`. Change the letter, or replace the span with
your image:

```html
<img class="logo" src="/shared/my-logo.svg" alt="" width="30" height="30">
```

Put the image in `shared/`, which every server serves at `/shared/`, so both
front-ends can use it. Keep `alt=""`: the name beside the logo already says
what it is. In React, write `className` instead of `class`.

**Pages in the navigation.** The sidebar's "Your modules" lists `MODULES` in
`shared/ui.js`. Remove Tickets, or rename it, there. To build a real screen,
see [Add a module](#add-a-module).

## Choose who signs in

`DC_IDENTITY` decides who the server believes is calling. See
[`docs/providers/identity.md`](docs/providers/identity.md) for the interface.

| You want | Set |
|---|---|
| Try it locally, no sign-in | `DC_IDENTITY=dev` (the default; production refuses it) |
| A private CRM for one person or one small team | `DC_IDENTITY=passcode` and `DC_PASSCODE=<12+ characters>` |
| Real accounts through a service you already use | `DC_IDENTITY=oidc` and the recipe below |
| Anything else | `DC_IDENTITY=./my-identity.js` (or `.py`) |

The passcode path needs nothing in the browser: the page shows a sign-in form
and keeps a signed, HttpOnly cookie for 12 hours. Changing `DC_PASSCODE` signs
everyone out.

## Sign in with your own identity provider (OIDC)

With `DC_IDENTITY=oidc` the browser sends `Authorization: Bearer <JWT>` and the
server checks it. Three things are always the same:

1. **Server settings.** `DC_OIDC_ISSUER`, `DC_OIDC_AUDIENCE`, and
   `DC_OIDC_JWKS_URL` when the service does not publish a discovery document.
2. **The issuer must match the token's `iss` exactly**, character for
   character, including a trailing slash. Decode a real token and copy its
   `iss`. Changing the spelling later changes the user ids the server derives
   for non-UUID subjects, so pick it once.
3. **The page needs to hand over the token.** Call `setAuthHeaderProvider`
   once, before the app starts (in `vanilla/app.js`, or in
   `react/src/main.jsx`). It runs before every API call and the event stream
   asks it too.

```js
// vanilla/app.js
import { setAuthHeaderProvider } from '/shared/server-api.js';
// react/src/main.jsx
import { setAuthHeaderProvider } from '@shared/server-api.js';

setAuthHeaderProvider(async () => {
    const token = await getTokenFromYourSignInLibrary();
    return token ? { Authorization: 'Bearer ' + token } : null;
});
```

Return `null` when nobody is signed in. The request still goes out, the server
answers `401 unauthenticated`, and the page shows that explanation instead of
failing silently. Only RS256 and ES256 tokens are
accepted. A token with a UUID `sub` keeps it as the user id; any other `sub` is
mapped to a stable UUID.

Verify any recipe with the checker before you rely on it:

```sh
npm run conformance:provider -- identity oidc DC_OIDC_ISSUER=<issuer> DC_OIDC_AUDIENCE=<audience>
```

That checks the settings and the provider's shape. It does not call your
issuer, and neither does `npm run doctor`; only a real sign-in does. Open the
app and sign in: `401 invalid_token` means the token was refused (check the
issuer and audience), `401 unauthenticated` means the page sent no token, and
`503 identity_unavailable` means the server could not reach the issuer.

### Auth0

```sh
DC_IDENTITY=oidc
DC_OIDC_ISSUER=https://YOUR-TENANT.us.auth0.com/     # keep the trailing slash
DC_OIDC_AUDIENCE=https://crm.example.com/api         # the API identifier you created in Auth0
```

Create an API in the Auth0 dashboard and use its identifier as the audience.
Without an audience, Auth0 returns an opaque token this server cannot verify.
In the page, ask for the same audience:

```js
const token = await auth0.getTokenSilently({ authorizationParams: { audience: 'https://crm.example.com/api' } });
```

(`getAccessTokenSilently` in the React SDK.)

### Clerk

```sh
DC_IDENTITY=oidc
DC_OIDC_ISSUER=https://YOUR-FRONTEND-API.clerk.accounts.dev   # your Clerk Frontend API URL, no slash
DC_OIDC_AUDIENCE=starter-crm
```

Clerk's default session token has no `aud` claim, and this server requires one.
In the Clerk dashboard create a JWT template that adds `"aud": "starter-crm"`,
and fetch tokens with it:

```js
const token = await clerk.session.getToken({ template: 'starter-crm' });
```

### Supabase Auth

```sh
DC_IDENTITY=oidc
DC_OIDC_ISSUER=https://YOUR-PROJECT-REF.supabase.co/auth/v1
DC_OIDC_AUDIENCE=authenticated
DC_OIDC_JWKS_URL=https://YOUR-PROJECT-REF.supabase.co/auth/v1/.well-known/jwks.json
```

This needs the project's asymmetric JWT signing keys (the current default for
new projects). A project still on the legacy shared HS256 secret issues tokens
this server refuses on purpose, because accepting HS256 would mean sharing a
secret with the server. Rotate to asymmetric keys in the Supabase dashboard.
Supabase subjects are UUIDs, so they become the user id unchanged.

```js
const { data } = await supabase.auth.getSession();
const token = data.session ? data.session.access_token : null;
```

### Firebase Authentication

```sh
DC_IDENTITY=oidc
DC_OIDC_ISSUER=https://securetoken.google.com/YOUR-PROJECT-ID
DC_OIDC_AUDIENCE=YOUR-PROJECT-ID
```

Leave `DC_OIDC_JWKS_URL` empty: Firebase publishes a discovery document at
`https://securetoken.google.com/YOUR-PROJECT-ID/.well-known/openid-configuration`,
and the server reads the key set's address from it. Use the ID token, not an
access token:

```js
const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
```

### Auth.js and other cookie sessions

Auth.js (NextAuth) encrypts its session token by default, so a server that
only holds a public key cannot read it. Pick one:

- Make your Auth.js app sign a JWT (RS256 or ES256) for the CRM server and
  point `oidc` at its key set; or
- Write a small custom identity that decrypts the session with your own
  `AUTH_SECRET` (below).

## Write your own identity

When none of the above fits, such as a session table in your own database,
write a provider. This one trusts a signed header from your reverse proxy:

```js
// my-identity.js
import crypto from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const name = 'proxy-header';
export const configKeys = ['PROXY_AUTH_SECRET'];

export function validate(env) {
    return env.PROXY_AUTH_SECRET
        ? []
        : [{ code: 'missing_proxy_auth_secret', message: 'PROXY_AUTH_SECRET is not set.', fix: 'Set PROXY_AUTH_SECRET to the secret your proxy signs with.', docs: '' }];
}

export function create(ctx) {
    const secret = ctx.env.PROXY_AUTH_SECRET;
    return {
        async authenticate(request) {
            const user = request.headers.get('x-auth-user');
            const signature = request.headers.get('x-auth-signature');
            if (!user || !signature) return null;
            const expected = crypto.createHmac('sha256', secret).update(user).digest('hex');
            const same = signature.length === expected.length
                && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
            // A bad signature is "not signed in", never an exception.
            return same && UUID.test(user) ? { id: user.toLowerCase() } : null;
        }
    };
}
```

Then `DC_IDENTITY=./my-identity.js` and check it:

```sh
npm run conformance:provider -- identity ./my-identity.js PROXY_AUTH_SECRET=example-only-secret
```

The Python server takes the same idea in `my_identity.py` with `name`,
`config_keys`, `validate(env)` and `create(ctx)`. Run
`python -m starter_crm.provider_check identity ./my_identity.py PROXY_AUTH_SECRET=example-only-secret`.
The `id` must be a UUID, because Drop Cowboy uses it as the token's subject, and
the example refuses anything else. If your proxy sends a username or an email,
turn it into a stable UUID first: a version 5 UUID of it, with
`DROPCOWBOY_SITE_ID` as the namespace, is what the `oidc` identity does.

Keep this file at the starter root while you build it. For Docker, move it into
`server/node/src/` (and point `DC_IDENTITY` there) or copy it into the image; see
[Your own files in the image](HOSTING.md#your-own-files-in-the-image).

## Send errors to Sentry

An observer's `onError` runs for every `500 internal_error`. Write
`server/node/src/my-observer.js`, inside the server folder so it can import the
packages installed there:

```js
import * as Sentry from '@sentry/node';

export const name = 'sentry';
export const configKeys = ['SENTRY_DSN'];

export function validate(env) {
    return env.SENTRY_DSN
        ? []
        : [{ code: 'missing_sentry_dsn', message: 'SENTRY_DSN is not set.', fix: 'Set SENTRY_DSN from your Sentry project.', docs: '' }];
}

export function create(ctx) {
    Sentry.init({ dsn: ctx.env.SENTRY_DSN, environment: ctx.config.env });
    return {
        async onError(event) {
            Sentry.captureMessage(event.message, { level: 'error', tags: { request_id: event.request_id } });
            // flush() is awaited so a serverless host does not freeze before it sends.
            await Sentry.flush(2000);
        }
    };
}
```

```sh
cd server/node && npm install @sentry/node
# then, in .env at the starter root:
DC_OBSERVER=./server/node/src/my-observer.js
```

`onError` receives the message and request id, never the request body, headers
or a token, so nothing sensitive reaches Sentry. In Python install
`sentry-sdk` and call `sentry_sdk.capture_message` from `on_error` the same
way, then `sentry_sdk.flush(timeout=2)`.

## Send traces to OpenTelemetry

`onRequest` and `onResponse` carry the same `request_id`, which is all you need
to record a span per request with whatever exporter you already use. This one
records the duration as a metric:

```js
import { metrics } from '@opentelemetry/api';

export const name = 'otel';
export const configKeys = [];
export function validate() { return []; }

export function create() {
    const meter = metrics.getMeter('starter-crm');
    const duration = meter.createHistogram('http.server.duration', { unit: 'ms' });
    return {
        async onResponse(event) {
            duration.record(event.duration_ms, { method: event.method, status: event.status });
        }
    };
}
```

Install and configure the OpenTelemetry SDK the way your vendor documents (an
`--import` file that starts the SDK), save the observer as
`server/node/src/my-observer.js`, and set
`DC_OBSERVER=./server/node/src/my-observer.js`.
`path` has no query string, but later phases add routes that carry ids, so
leave it out of metric attributes unless you want one series per id.

## Read secrets from a vault or mounted files

For Docker or Compose secrets, no code is needed:

```sh
DC_SECRETS=file
DC_SECRETS_DIR=/run/secrets
```

with one file per secret named like the variable (`DROPCOWBOY_API_KEY`,
`DROPCOWBOY_API_SECRET`, `DROPCOWBOY_WEBHOOK_SECRET`, `DC_PASSCODE`). For
Doppler, Infisical, HashiCorp Vault or OpenBao, or 1Password, set
`DC_SECRETS=doppler`, `infisical`, `vault` or `1password` and the settings in
[`docs/providers/secrets.md`](docs/providers/secrets.md); no code is needed. For
any other manager, write a provider, described in the same file. A running server
re-reads rotated values every `DC_SECRETS_REFRESH_SECONDS` without a restart,
except `DC_PASSCODE`, which is read once at boot.

## Share rate limits across instances

`DC_RATE_LIMIT=memory` counts per process. With several instances, set
`DC_REDIS_URL`: the limit then moves to Redis on its own (`DC_RATE_LIMIT=redis`)
and every instance shares one count. Without Redis, write a limiter over your
database; see [`docs/providers/ratelimit.md`](docs/providers/ratelimit.md) for
the one method it needs and the conformance check. Behind a proxy, also set
`DC_TRUST_PROXY` so the limiter sees each user's address, not the proxy's.

## Run your own code when a webhook arrives

Write a file that exports `handlers` and point `DC_WEBHOOK_HANDLERS` at it. Each
handler runs after the event is safely stored and the `200` is on its way, so it
may take as long as it needs (in `store` and `bullmq` modes).

```js
// ./my-handlers.js
export const handlers = {
    'contact.msg.received': async (event, { eventId, attempt, signal, log }) => {
        // Await all of your work. Use eventId as the key so a second run changes nothing.
    }
};
```

```python
# ./my_handlers.py
def on_message(event, ctx):
    ...  # ctx.event_id, ctx.attempt, ctx.signal, ctx.log

handlers = {"contact.msg.received": on_message}
```

Throw to ask for a retry: it runs again after 1 s, then 2 s, doubling up to
5 minutes, and after `DC_WEBHOOK_MAX_ATTEMPTS` the event is marked `failed` and
shows on the Setup page. `npm run webhooks:failed` lists them and
`npm run webhooks:replay -- <event_id>` runs one again. A handler can run more
than once for one event, so make it idempotent. Do not start work and return
without awaiting it: a host can freeze the process once the handler returns.
See [`docs/providers/webhooks.md`](docs/providers/webhooks.md).

With `DC_WEBHOOKS=inline`, for hosts that freeze between requests, it is the
other way round: handlers run before the answer and must finish in about three
seconds. A handler that throws makes the webhook answer `503`, and Drop
Cowboy's own retries apply (a few attempts, minutes apart) instead of the
schedule above.

A handlers file at the starter root is not in the Docker images; see
[Your own files in the image](HOSTING.md#your-own-files-in-the-image).

## Keep events in a database

Set `DC_STORE=sqlite` for one machine, `postgres` with `DC_DATABASE_URL` for
several instances, or `redis` with `DC_REDIS_URL`. Tables are created at boot.
To use your own database, write a store (`DC_STORE=./my-store.js`); the interface
and the cases it must pass are in
[`docs/providers/store.md`](docs/providers/store.md).

## Add a module

A **module** is a screen of your own with its own data, such as tickets, quotes
or a pipeline of anything you sell. It lives beside the starter's code, so
upgrading the starter never overwrites it. Deals is the worked example, with its
page in both front-ends, its routes on both servers and its tests.

Modules run in server mode (`DC_AUTH_MODE=server`), because their data belongs to
the signed-in user. Each user sees only their own records, and another user's
record looks exactly like one that does not exist.

```sh
npm run new:module -- tickets            # a module with a title, notes and a done flag
npm run new:module -- staff --singular staff-member   # when the name does not end in "s"
```

That writes three files and changes nothing else:

| File | What it is |
|---|---|
| `server/node/src/modules/tickets/index.js` | The routes and event handlers on the Node server. |
| `server/python/starter_crm/modules/tickets.py` | The same routes on the Python server. |
| `server/schemas/tickets.json` | What each route accepts. Both servers read this one file. |

Restart the server and the routes are live at `/api/modules/tickets`. Then:

1. **Change the fields.** Edit the schema, then the `insert` call in both servers.
   A bad request answers `400 invalid_request` and names the field.
2. **Keep both servers the same.** If you use only one, delete the other's file; if
   you use both, the conformance suite is how you know they agree. Copy
   `server/conformance/suite/22-modules-deals.test.js`.
3. **Build the screen.** The sidebar lists `MODULES` in `shared/ui.js`, which
   already has a Tickets placeholder (add an entry for any other name). Copy
   `vanilla/pages/deals.js` to `tickets.js` and `react/src/pages/DealsPage.jsx`
   to `TicketsPage.jsx`. Then send the module's id to them, next to the line
   for Deals: in `vanilla/pages/module.js` add
   `if (params.id === 'tickets') return renderTickets(main, context);`, and in
   `react/src/pages/ModulePage.jsx` add
   `if (id === 'tickets') return <TicketsPage />;`, importing each new page at
   the top. Until you do, the sidebar link still shows the placeholder. The
   pages call the module's routes with `callServer` and can show any Drop
   Cowboy widget, such as `<dc-contact-card>`, beside a record.
4. **React to Drop Cowboy.** Add `onEvent` (`on_event` in Python) with the events
   you care about. Deals archives a deal when its contact is deleted, so the
   page never shows a deal for someone who asked to be forgotten. A handler can
   run twice for one event, so write it to be safe to run twice, and await
   everything it starts.
5. **Choose where the data lives.** `DC_DATA` follows `DC_STORE` by default. With
   `memory` it vanishes on restart; use `sqlite` or `postgres` for anything you
   want to keep. See [`docs/providers/data.md`](docs/providers/data.md). Back it
   up like the event store.

Keep customer code in modules, `.env` settings and providers (a custom
`DC_DATA`, `DC_STORE`, `DC_IDENTITY`...). Do not edit `core`, `auth` or the
webhook code to add a feature: those are shared with the starter, and your edit
would conflict with every upgrade.
