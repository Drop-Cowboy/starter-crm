# Glossary

The words these docs use, in plain language. If a page uses a word that isn't
here, [open an issue](https://github.com/Drop-Cowboy/starter-crm/issues) and
we'll add it.

**555 number** — A free test phone number, such as `+1 555 555 0002`. Calls
and texts to it never reach a real phone. The last four digits pick what
happens, such as voicemail or busy. See
[test numbers](https://www.dropcowboy.com/developers/api/test-numbers).

**API key and secret** — The username and password your server uses to talk to
Drop Cowboy. They stay on the server, never in the browser or in git. Create
them in the dashboard under
[Developers > API Keys](https://www.dropcowboy.com/app/#/api-keys); that needs
a paid plan.

**Building Blocks** — Drop Cowboy's ready-made pieces of screen: the phone,
inbox, contact card and the rest. The starter loads them from Drop Cowboy, not
from npm.

**Business number** — The phone number your texts come from. Real phones need
one; 555 numbers don't.

**Carrier (BYOC)** — The phone company account your calls and texts run on.
BYOC means "bring your own carrier": you connect an account you have, such as
Twilio or Telnyx, in the Drop Cowboy dashboard. Until you do, only 555 numbers
work.

**Consent** — A contact's agreement to be called or texted. The law requires
it, so Drop Cowboy refuses to call or text a real number without it and
answers `consent_required`. 555 numbers skip the check.

**Dock** — The phone panel at the side of the screen, for calls and texts. It
stays put as you move between pages.

**Embedded layout** — The starter shown inside another app, such as a page in
your existing product, without its own sidebar. Add `?layout=embedded` to the
address.

**Environment variable, `.env`** — A setting the server reads when it starts.
`npm run setup` writes them to a file called `.env`, which git never commits.
On a host such as Netlify, you type them into its settings page instead.

**Front-end** — The part that runs in the browser. The starter has two that
look and work the same: `vanilla/`, plain JavaScript with no build step, and
`react/`. The page at http://127.0.0.1:8080 is `vanilla/`; the React one is at
`/react/` once you build it. Pick either.

**MCP server** — A way for an AI assistant to use Drop Cowboy: check your
account, look things up and read logs. Its address is
`https://mcp.dropcowboy.com/mcp`. See [Build with AI](build-with-ai.md).

**Module** — A screen of your own with its own data, such as Deals. Modules
live beside the starter's code, so upgrading never overwrites them. See
[Add a module](../CUSTOMIZE.md#add-a-module).

**Postgres** — A database. A deployed starter keeps its events and module data
in one so they survive restarts. Netlify and Vercel can create one for you;
it's often called Neon, the company that runs it.

**Purpose** — What a page needs a token for: `contacts` for the contact pages,
`session` for calling and the inbox, `campaigns` or `phone`. The server
decides what each purpose may do, never the browser. See
[how it works](how-it-works.md#tokens-and-why-each-page-asks-for-one).

**Sandbox mode** — An account that can't yet call or text real numbers,
because it has no carrier connected or no funds. It can still call and text
555 numbers. The contact page says so under Call and Text, and a call or text
to a real number is refused.

**Scope** — One permission an API key or token has, such as `contacts:read`.

**Server** — The part that runs on your computer or host, not in the browser.
It keeps your API key, hands the browser tokens, and receives webhooks. The
starter has two that behave the same: Node.js (the default) and Python.

**Token** — A short-lived pass the server gives the browser, so a page can use
Drop Cowboy without ever seeing your API key. Each lasts 15 minutes and can
do only what its purpose allows.

**Webhook** — A message Drop Cowboy sends your server when something happens,
such as a text arriving. It's how the starter shows live activity. See
[Webhooks](webhooks.md).

**Webhook secret** — The password your server uses to check that a webhook
really came from Drop Cowboy. It's shown when you create the webhook.
