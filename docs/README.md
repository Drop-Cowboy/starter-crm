# Starter CRM docs

Find what you want to do, and the page for it. New here? Start with the
[README](../README.md): it gets the CRM running in a few minutes.

## Get started

| I want to... | Read |
|---|---|
| Run the CRM on my computer | [README: quick start](../README.md) |
| Build with an AI assistant, with or without coding | [Build with AI](build-with-ai.md) |
| Look up a word | [Glossary](glossary.md) |
| Fix something that's not working | [Troubleshooting](../TROUBLESHOOTING.md) |

## Make it mine

| I want to... | Read |
|---|---|
| Change the name, logo or colours | [Common changes](../CUSTOMIZE.md#common-changes) |
| Know which file to open for a change | [How it works](how-it-works.md) |
| Add a screen of my own, such as tickets | [Add a module](../CUSTOMIZE.md#add-a-module) |
| Let my team sign in | [Choose who signs in](../CUSTOMIZE.md#choose-who-signs-in) |
| See replies and missed calls as they happen | [Webhooks](webhooks.md) |
| Run my own code when something happens | [Webhook handlers](../CUSTOMIZE.md#run-your-own-code-when-a-webhook-arrives) |

## Go live

| I want to... | Read |
|---|---|
| Put it on the internet | [Hosting](../HOSTING.md): Netlify, Vercel, Docker or AWS |
| Check it's ready for real users | [Production checklist](../PRODUCTION.md) |
| Get a newer version of the starter | [Upgrading](../UPGRADING.md) and the [changelog](../CHANGELOG.md) |

## Go deeper

For developers replacing a part of the server. Each part has a default that
works, so you only need these to swap one out.

| Part | What it decides |
|---|---|
| [Identity](providers/identity.md) | Who is signed in |
| [Secrets](providers/secrets.md) | Where the API key and other secrets are read from |
| [Event store](providers/store.md) | Where webhook events are kept |
| [Webhook modes](providers/webhooks.md) | How your webhook handlers run |
| [Fan-out](providers/fanout.md) | How live activity reaches every copy of the server |
| [Module data](providers/data.md) | Where your modules keep their records |
| [Rate limits](providers/ratelimit.md) | How sign-in and tokens are protected from abuse |
| [Logs](providers/log.md) | Where the server's logs go |
| [Observers](providers/observer.md) | Errors, traces and metrics, such as Sentry |

The tests are described in [`tests/README.md`](../tests/README.md). For the
Drop Cowboy API itself, see the
[developer docs](https://www.dropcowboy.com/developers).
