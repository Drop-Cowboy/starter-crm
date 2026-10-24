# Webhooks: see what happens, as it happens

This page is for anyone who wants the starter to show activity, such as
replies and missed calls, the moment it happens. Replies already reach the
Inbox without this. When you're done, the Activity panel fills by itself, a
toast pops up when a text arrives, and your own code can react to events if
you want it to.

Until you set this up, the server prints
`DROPCOWBOY_WEBHOOK_SECRET is not set, so webhooks will be refused with 503.`
when it starts. That's expected, and everything else works without it.

- [How it works](#how-it-works)
- [Step 1: give the server a public address](#step-1-give-the-server-a-public-address)
- [Step 2: create the webhook](#step-2-create-the-webhook)
- [Step 3: save the signing secret](#step-3-save-the-signing-secret)
- [Check that it works](#check-that-it-works)
- [Good to know](#good-to-know)
- [Run your own code when an event arrives](#run-your-own-code-when-an-event-arrives)

## How it works

A **webhook** is Drop Cowboy calling your server when something happens. You
give Drop Cowboy an address, and it sends each event there as a signed request.
The starter's address for them is `/webhooks/dropcowboy`.

The **signing secret** proves a request really came from Drop Cowboy. Drop
Cowboy signs every request with it, and the server refuses any request whose
signature doesn't match. It's a password, so keep it out of git.

## Step 1: give the server a public address

Drop Cowboy is on the internet, so it can't reach `http://127.0.0.1:8080` on
your computer. Use one of these:

- **It's deployed.** Use its address, such as `https://crm.example.com`.
  [Hosting](../HOSTING.md) covers deploying.
- **It's on your computer.** Run a tunnel, which gives your computer a
  temporary public address. With [Cloudflare's free tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/):

  ```bash
  cloudflared tunnel --url http://127.0.0.1:8080
  ```

  It prints an address ending in `.trycloudflare.com`. Keep it running while
  you work. You get a new address each time you start it, so you'd update the
  webhook each time too.
- **It's in a Codespace.** In the **Ports** tab, right-click port 8080 and set
  its visibility to **Public**, then copy its address.

Your webhook address is that public address followed by `/webhooks/dropcowboy`,
for example `https://crm.example.com/webhooks/dropcowboy`.

## Step 2: create the webhook

Create **one** webhook. Each one sends every event separately, so a second
webhook to the same address makes every event arrive twice.

### In the dashboard (no code)

1. Open [**Developers > Webhooks**](https://www.dropcowboy.com/app/#/webhooks)
   and click **Add Webhook**.
2. Give it a name, such as "Starter CRM", and paste your webhook address into
   **Webhook URL**.
3. Under **Events to Send**, turn on **Subscribe to all events**.
4. Click **Create**.
5. The new webhook shows its signing secret, hidden. Click the eye to reveal
   it, or the copy button to copy it.

### With the API

This creates the webhook with the events the Activity panel shows, and writes
the secret to `.env` without printing it. You need [`jq`](https://jqlang.org).
Run it once, from the starter's folder, with the address on the first line
changed to yours:

```bash
HOOK_URL=https://crm.example.com/webhooks/dropcowboy
set -a; . ./.env; set +a
SECRET=$(curl -sf -X POST https://api-v2.dropcowboy.com/register/public/webhooks \
  -H "x-key: $DROPCOWBOY_API_KEY" -H "x-secret: $DROPCOWBOY_API_SECRET" -H "Content-Type: application/json" \
  -d '{"hook_url":"'"$HOOK_URL"'","event_types":["contact.created","contact.updated","contact.deleted","contact.msg.received","contact.msg.sent","contact.msg.opt","contact.sms.status","contact.call.answered","contact.call.missed","contact.call.hangup","contact.voicemail.received","contact.rvm.status","contact.consent.granted","contact.consent.revoked","contact.pipeline.stage.entered"]}' \
  | jq -r '.data.signing_secret // empty')
if [ -z "$SECRET" ]; then
  echo "Creating the webhook failed"
else
  (umask 077; { grep -v '^DROPCOWBOY_WEBHOOK_SECRET=' .env; echo "DROPCOWBOY_WEBHOOK_SECRET=$SECRET"; } > .env.new) && mv .env.new .env
  echo "Saved the signing secret in .env"
fi
```

If it prints "Creating the webhook failed", open **Developers > Webhooks**
before running it again: if a webhook to your address is there, copy its
secret as in Step 3 instead of creating a second one. If it worked, skip to
[Check that it works](#check-that-it-works) after restarting the server.

## Step 3: save the signing secret

Open `.env` in the starter's folder and set:

```bash
DROPCOWBOY_WEBHOOK_SECRET=<the signing secret you copied>
```

On a host, set it wherever the host keeps secrets instead ([Hosting](../HOSTING.md)
says where for each). Then restart the server: stop it with Ctrl+C and run
`npm start` again. The line about webhooks being refused is gone.

## Check that it works

**From your own computer.** This sends a signed, made-up `contact.created`
event straight to the local server, so it checks the secret without Drop Cowboy
or a tunnel:

```bash
npm run webhook:test -- contact.created
```

You should see `200 {"received":true}`, and the event appears in the Activity
panel. `npm run doctor`, run while the server is up, sends the same kind of
event along with its other checks.

**From Drop Cowboy.** Text a contact with a 555 number. A few seconds later the
reply arrives as a `contact.msg.received` event, and a "Text received" toast
appears.

Nothing arriving? See [Troubleshooting: no live activity](../TROUBLESHOOTING.md#no-live-activity).
Drop Cowboy's **Developers > Logs** page lists every delivery and the answer
your server gave.

## Good to know

- **The panel survives a reload.** The server keeps the latest 200 events and
  sends them to each page that opens. Only events after those make a toast or
  add to the Activity count.
- **Rotating the secret.** Make a new secret with **Regenerate Secret** in the
  webhook's ⋮ menu in the dashboard, or with
  `POST /register/public/webhooks/{webhook_id}/rotate-secret`.
  The new one takes over at once, retries included. The server accepts any of
  several secrets separated by commas, so set
  `DROPCOWBOY_WEBHOOK_SECRET=<new>,<old>` straight away and drop the old one a
  minute later.
- **Limits and housekeeping.** An account can have up to 50 webhooks. List them
  with `GET /register/public/webhooks` and delete one with
  `DELETE /register/public/webhooks/{webhook_id}`, or use the dashboard page.
- **Calls carry who placed them.** Calls placed from the starter carry
  `site_id` and `external_user_id` (your user's id) on their `contact.call.*`
  events.
- **Answer fast.** Drop Cowboy waits 5 seconds for an answer. The server stores
  each event and answers at once, then runs your code afterwards, so slow code
  never makes Drop Cowboy wait. A host that sleeps when idle will miss events.
  The exception is `DC_WEBHOOKS=inline`, for hosts that freeze between
  requests: there your code runs before the answer, so keep it to about three
  seconds, and a failure answers `503` so Drop Cowboy tries again.

Drop Cowboy's [webhooks reference](https://www.dropcowboy.com/developers/api/webhooks)
lists every event and what's in it.

## Run your own code when an event arrives

To do something of your own, such as tagging a contact when they reply, add a
handler. [Customize: run your own code when a webhook arrives](../CUSTOMIZE.md#run-your-own-code-when-a-webhook-arrives)
shows how. A handler can run twice for the same event, so write it so that
running twice does no harm, and use the event's id to tell.

[Webhook modes](providers/webhooks.md) explains where handlers run, how they're
retried, and how to replay failed events, for when you run more than one server.
