# Identity providers

An identity answers one question for every protected request: **who is this?**
The server uses the answer as the `sub` of the site token it mints, so Drop
Cowboy sees each of your users as a separate person.

Set `DC_IDENTITY` (only used with `DC_AUTH_MODE=server`).

| Value | Who it is for | Settings |
|---|---|---|
| `dev` | Local work. Everyone is the user in `STARTER_CRM_USER_ID`. `DC_ENV=production` refuses it (`production_dev_identity`). | `STARTER_CRM_USER_ID` |
| `passcode` | A team of one, or a small team that shares a login. One passcode, a signed 12-hour cookie. | `DC_PASSCODE` (12+ characters, secret), `STARTER_CRM_USER_ID` (optional) |
| `oidc` | Your users already sign in with Auth0, Clerk, Supabase, Firebase, Okta, Keycloak or any OpenID Connect issuer. The browser sends `Authorization: Bearer <JWT>`. | `DC_OIDC_ISSUER`, `DC_OIDC_AUDIENCE`, `DC_OIDC_JWKS_URL` (optional) |
| `./path` | Your own session system. | Whatever you declare in `configKeys` |

[`CUSTOMIZE.md`](../../CUSTOMIZE.md) has the exact settings for each sign-in
service. [`server/CONTRACT.md`](../../server/CONTRACT.md) ("Identity routes") is
the precise behavior both servers follow.

## The interface

A provider is a module that exports four things.

| Export | Node | Python |
|---|---|---|
| Short name, used in logs | `name` | `name` |
| Variables it reads | `configKeys` | `config_keys` |
| Check the settings | `validate(env)` returns boot problems | `validate(env)` |
| Build the instance | `create(ctx)`, may be async | `create(ctx)` |

`ctx` holds `config` (the parsed settings), `env` (the merged environment),
`log` and `root` (the starter folder). A boot problem is `{ code, message,
fix }`. Never put a secret in a message.

The instance has:

- `authenticate(request)` returns `{ id, email?, name? }`, or `null` when
  nobody is signed in. `id` must be a UUID. It must **not throw for a bad
  credential**: return `null`. Throw only when the identity system itself is
  down; the server answers `503 identity_unavailable`.
- Optional `routes()` returns extra routes `{ method, path, handler }`, for
  example a sign-in route. Paths must start with `/api/auth/` and the method
  is `GET` or `POST`. Set `cookieAuth: true` on the instance if you
  authenticate with a cookie, so the server applies the CSRF check to your
  `POST` routes.
- Optional `challenge`, a string such as `"Bearer"`, sent as the
  `WWW-Authenticate` header on a `401`.

In Node, `request` is a web-standard `Request`. In Python it is the Flask
request. Both have a case-insensitive `headers.get(name)`.

## Write your own

Node, `my-identity.js` in the starter root:

```js
export const name = 'my-identity';
export const configKeys = ['MY_SESSION_SECRET'];

export function validate(env) {
    if (!env.MY_SESSION_SECRET) {
        return [{
            code: 'missing_session_secret',
            message: 'MY_SESSION_SECRET is not set.',
            fix: 'Set MY_SESSION_SECRET to a long random value.',
            docs: 'TROUBLESHOOTING.md#invalid_provider'
        }];
    }
    return [];
}

export function create(ctx) {
    return {
        async authenticate(request) {
            const header = request.headers.get('x-demo-user');
            // Replace this with a real lookup in your session store.
            return header ? { id: header } : null;
        }
    };
}
```

Python, `my_identity.py`:

```python
name = "my-identity"
config_keys = ["MY_SESSION_SECRET"]


def validate(env):
    return []


def create(ctx):
    class Identity:
        def authenticate(self, request):
            header = request.headers.get("x-demo-user")
            return {"id": header} if header else None

    return Identity()
```

Point `DC_IDENTITY=./my-identity.js` (or `./my_identity.py`) at it.

## Check it

```sh
npm run conformance:provider -- identity ./my-identity.js
python -m starter_crm.provider_check identity ./my_identity.py
```

A built-in name works too: `npm run conformance:provider -- identity passcode DC_PASSCODE=example-passcode-1234`.

The check loads the file, confirms the exports, runs `validate`, builds the
instance, and confirms `authenticate` returns `null` when no credentials are
sent. Pass `NAME=value` arguments to supply the settings your provider needs.

To have the check try real credentials, export `testVectors` (`test_vectors` in
Python), a list of `{ name, headers, expect }`. `expect` is `null` for a request
that must not sign in, or the fields the returned user must have:

```js
export const testVectors = [
    { name: 'demo header signs in', headers: { 'x-demo-user': '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d' },
      expect: { id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d' } },
    { name: 'a stranger does not', headers: {}, expect: null }
];
```

An identity that signs everyone in on purpose (like `dev`) sets
`alwaysSignedIn = true` (`always_signed_in` in Python) so the check expects a user instead of `null`.

## What the front-end does

In `passcode` mode the page shows a sign-in form and the browser keeps the
cookie; nothing to write. In `oidc` (or your own bearer-token) mode, tell the
page how to get a token once, before the app starts:

```js
import { setAuthHeaderProvider } from './shared/server-api.js';

setAuthHeaderProvider(async () => {
    const token = await auth.getAccessToken();
    return token ? { Authorization: 'Bearer ' + token } : null;
});
```

Every API call, and the live event stream, then carries that header.
