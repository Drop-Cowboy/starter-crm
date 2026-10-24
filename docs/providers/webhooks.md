# Webhook modes

After the server has verified a webhook's signature and stored the event, a
**mode** decides how your handlers run. Every mode ends in the same processor:
it reads the event, runs your handlers, marks the event `processed` (or
`failed`), and publishes it to the fan-out so browsers see it.

Set `DC_WEBHOOKS`. Leave it unset to get the right one.

| Value | Handlers run | Use it when |
|---|---|---|
| `store` | In a worker that takes events from an outbox in the event store. | A long-running host. The default unless a queue is configured. |
| `bullmq` | In a worker on a Redis queue of event ids. A Node and a Python server can work one queue. | You run several instances or workers and already have Redis. The default with a durable store and `DC_REDIS_URL`. |
| `sqs` | In a worker on an Amazon SQS queue of event ids (`DC_SQS_QUEUE_URL`). A Node and a Python server can work one queue. | You run on AWS with the `dynamodb` store and no Redis. The default when `DC_STORE=dynamodb` and a queue URL is set. |
| `vercel-queue` | In a route Vercel Queues calls with each event id. No worker. Node only (the Next.js variant). | You deploy to Vercel. The default there. Vercel Queues is a public beta. |
| `netlify-async` | In a workload function that Netlify Async Workloads runs with each event id. No worker. Node only (the Netlify variant). | You deploy to Netlify with the Async Workloads extension. The default there. |
| `qstash` | In a route that Upstash QStash calls, signed, with each event id. No worker. Node and Python. | A host with no process between requests (Vercel, Netlify), or any host with a public address, and no Redis or AWS. The tested fallback when Vercel Queues or Async Workloads is not an option. |
| `inline` | In the webhook request, before the `200`. | Handlers that finish in under about 3 seconds, or a host that freezes the process between requests. |
| `./path` | Yours. | |

`store`, `bullmq`, `sqs`, `vercel-queue`, `netlify-async` and `qstash` answer `200` as soon as the event is stored and queued, so
a slow handler never delays Drop Cowboy (which waits 5 seconds). `inline` waits:
`DC_WEBHOOK_HANDLER_BUDGET_MS` (default 3000, at most 4500) is how long handlers
get before their `signal` fires, and a failing handler answers `503` so Drop
Cowboy retries.

## What every mode promises

- **Stored before acknowledged.** A crash after the `200` loses nothing: the
  next worker finds the event.
- **At least once.** A handler can run twice for one event (a retry after a
  crash, a replay). Make it idempotent and use the event id as the key.
- **Retry with backoff.** A handler that throws is retried after 1 s, then
  doubling up to 5 minutes, until `DC_WEBHOOK_MAX_ATTEMPTS` (default 8, at most
  50). Then the event is `failed`, not retried again.
- **Replay.** `npm run webhooks:failed` lists failed events, and
  `npm run webhooks:replay -- <event_id>` (or `-- --all-failed`) runs them again.
  The Setup page and `npm run doctor` show how many have failed.
- **A duplicate delivery is harmless.** Drop Cowboy retries with the same event
  id. The server answers `{"received": true, "duplicate": true}` and queues the
  handlers again only if the first copy never finished.

## Where the worker runs

By default inside the web process (`DC_WORKER_IN_PROCESS=on`). To run it
separately set `DC_WORKER_IN_PROCESS=off` on the web instances and start
`npm run worker` (Python: `python -m starter_crm.worker`) with the same
environment. The worker needs a store other processes can reach (`sqlite` on the
same machine, `postgres` or `redis`) and a fan-out that crosses processes
(`poll`, `redis` or `postgres`). It serves no HTTP and, on SIGTERM, finishes the
event in hand and exits.

**SQS.** One message per event, `{event_id, site_id}` and nothing else, sent
before the `200`. SQS delivers at least once, so the same idempotency rule
applies. A failing handler keeps its message and sets the visibility timeout to
the backoff, so the retry comes at the right time. Use one queue per site, give
the queue a visibility timeout longer than your slowest handler (the template
uses 60 seconds), and a dead-letter queue: a message that keeps crashing the
worker moves there, and the event stays `received` in the store so the sweep
queues it again. The Python worker polls for 2 seconds at a time instead of 20,
because boto3 cannot abort a long poll and a stopping worker must not wait on
one.

**Vercel Queues and QStash.** There is no worker to run: the webhook stores the
event, sends `{event_id, site_id}` to the queue, and answers `200` once the queue
has accepted it. The queue then calls the server back (`/internal/queue/webhook-jobs`
for Vercel, `/internal/webhook-jobs` for QStash), and the processor runs there.
Delivery is at least once, so the idempotency rule applies. A failing handler
fails the callback and the queue retries after the usual backoff; a message the
queue gave up on leaves the event `received`, and the daily maintenance request
(`/internal/maintenance`, a Vercel Cron) publishes it again. QStash needs
`QSTASH_TOKEN`, both signing keys and `DC_PUBLIC_URL` (the address QStash calls),
and checks the signature of every call before it reads it. On Vercel, a webhook
mode that needs a process (`store`, or a worker mode) is refused at boot with a
message naming the fix, because the function is frozen between requests and the
events would never be handled.

**Netlify Async Workloads.** The same arrangement with Netlify's extension as the
queue. The webhook sends the event `starter-crm-webhook-job` with
`{event_id, site_id}` to the site's Async Workloads router, using `AWL_API_KEY`,
and answers `200` once the router has accepted it (`503`, so Drop Cowboy retries,
if it has not within 3 seconds). The router runs `server/netlify/functions/webhook-jobs.mjs`,
which runs the processor; no route of the server is involved. A failing handler
asks Async Workloads to retry after the usual backoff, which its scheduler picks up
on its next run (every 60 seconds by default). On Netlify the daily maintenance is a
scheduled function. The mode refuses to start off Netlify
(`netlify_async_off_netlify`) or without a key (`missing_awl_api_key`), and the
Python server refuses it (`netlify_async_node_only`); `qstash` works there instead.

**Redis Cluster.** BullMQ on a cluster works in the Node server
(`DC_REDIS_CLUSTER=on`). The Python server cannot do it (BullMQ for Python takes
only a single-server client): boot fails with `bullmq_cluster_unsupported`. Use
`DC_WEBHOOKS=store`, or `sqs` on AWS, or run the Node server.

BullMQ needs Redis with `maxmemory-policy noeviction`, or it can lose jobs. Boot
checks the policy and refuses to start otherwise (managed services that forbid
`CONFIG` run it themselves, and pass). The Compose `redis` profile sets it, with
AOF on.

## Your handlers

Point `DC_WEBHOOK_HANDLERS` at a file that exports `handlers`, a map from event
name to function. `*` matches every event.

```js
export const handlers = {
    'contact.msg.received': async (event, { eventId, attempt, signal, log }) => {
        // Write to your CRM, keyed by eventId so a second run changes nothing.
    },
    '*': async (event, ctx) => {}
};
```

```python
def on_message(event, ctx):
    ...  # ctx.event_id, ctx.attempt, ctx.signal (a threading.Event), ctx.log

handlers = {"contact.msg.received": on_message}
```

Always await your own work. Do not start something and return: on a host that
freezes the process after the response, unfinished work is lost.

## The interface

Export `name`, `configKeys` (`config_keys`), `validate(env)` and `create(ctx)`.
`ctx` has `config`, `env`, `store`, `processor` and `log`. The instance:

| Method | What it does |
|---|---|
| `dispatch(eventId)` | Hand the event to whatever will run it. Resolve only when it is durably queued (or, inline, handled). Returns `{ outcome }`; `retry` makes the webhook answer `503`. |
| `start()`, `stop()` | Begin working, and finish the event in hand before returning. |
| `ready()` | Whether it can take events: `/readyz` reports it. |
| `sweep(eventIds)` (optional) | Re-queue events that were stored but whose `dispatch` never completed. |
| `visibleDelayMs` (optional) | How long a freshly stored event stays out of the sweep's reach. |
