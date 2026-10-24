# shared/

Front-end modules for the Starter CRM. Start at the folder above this one.

Plain ES modules used by both front-ends. There is no build step: the vanilla
app imports them from `/shared/...` (the starter server serves this folder),
and the React app imports them through the `@shared` alias in its Vite config.
Both apps call `startCrm()` and then use only what it returns, so they differ
in rendering, never in how they talk to Drop Cowboy.

| Module | What it does |
|---|---|
| `crm.js` | `startCrm()`: loads `/api/config`, finishes a sign-in, and wires everything below. Starts the Dock (`session` token) and the contacts bundle (`contacts` token) at most once per page, each only when a page needs it. |
| `config.js` | Reads `/api/config`. Holds the widget API base (`https://app-api-v2.dropcowboy.com`) and the CDN version. |
| `server-api.js` | `callServer()`: same-origin JSON calls to the starter server. |
| `token-provider.js` | Gets a site token for a purpose (`session`, `contacts`, `campaigns`, `phone`) in the current auth mode, and caches it until near expiry. In `mcp-session` mode the contacts pages reuse the one session token. |
| `login.js`, `auth0-pkce.js` | "Sign in with Drop Cowboy" for `login` mode: Auth0 authorization code + PKCE. |
| `dropcowboy-cdn.js` | Loads only the Building Blocks bundles a page needs, each with its Subresource Integrity hash from the release manifest. |
| `contacts-api.js` | The headless contacts REST API, with the `contacts` token: list, search, get, create, update, delete. |
| `widgets.js` | Hands each Building Block the token for its purpose: `contacts` for the contact card and pipeline, the Dock's `session` for the inbox, `campaigns` and `phone` for their hubs. |
| `events.js`, `activity.js` | Live webhooks from `/api/events` (Server-Sent Events) plus Dock events, as one activity list. |
| `errors.js` | One place that turns every error code into a plain-language explanation and a fix. |
| `setup.js`, `settings.js` | The setup checklist, plus the business number and the theme choice (the only things kept in `localStorage`). |
| `format.js` | Names, phone numbers, dates. |
| `crm.css` | The one stylesheet both apps use. |

## Rules these modules keep

- **API keys never reach the browser.** The browser asks the starter server for
  a token by purpose. The server picks the scopes.
- **Least privilege per page.** A page that only reads and writes contacts
  holds a `contacts` token, not a calling one. Drop Cowboy checks for a
  connected carrier and a balance only when a token can call, so the contacts
  pages work before calling is set up.
- **A token is only ever a JavaScript value.** It is never put in a URL, an
  HTML attribute, `localStorage`, `sessionStorage` or a log. Widgets get it as
  a property (`tokenManager`) or through `init({ token, getToken })`.
- **Texts and calls name the contact** (`contact_id`), so Drop Cowboy logs them
  on the contact and can apply its consent when the team turns on "Use existing
  contact consent".

## Tests

```bash
npm test     # node --test, no dependencies
```
