# Fan-out providers

A webhook can reach one instance while a browser's activity stream is open on
another. The fan-out carries each **finished** event to every instance, which
hands it to the streams connected there. It sends only the event id; each
instance reads the event from the store, so contact data never travels through
pub/sub or a notification.

Set `DC_FANOUT`. Leave it unset to get the right one for your store.

| Value | How instances hear about an event | Default for |
|---|---|---|
| `local` | They do not. Only streams on the instance that finished it see it. | `memory` store, `sqlite` with the worker in the web process. |
| `poll` | Each instance asks the store for new events every `DC_FANOUT_POLL_MS` (default 1000). Runs only while a stream is open. | `sqlite` with a separate worker, and `dynamodb` without Redis. Works with any durable store. |
| `redis` | Redis pub/sub (`DC_REDIS_URL`). With `DC_REDIS_CLUSTER=on`, a Redis Cluster. | A shared store, when `DC_REDIS_URL` is set. |
| `postgres` | `LISTEN`/`NOTIFY` on the store's database. Needs a direct connection, not a transaction-mode pooler. | `postgres` store without Redis. |
| `./path` | Yours. | |

On Vercel and Netlify the default is `poll` (`redis` when `DC_REDIS_URL` is set),
because every request may land on a different function instance. `local` is
refused there (`serverless_fanout`), and a `postgres` fan-out falls back to `poll`
with a notice, since the pooled database URLs those hosts use do not deliver
`LISTEN`/`NOTIFY`. A stream there is capped by `DC_EVENTS_MAX_STREAM_SECONDS`
(290 on Vercel, 25 on Netlify) so it ends before the function's own limit, and
the browser reconnects with `Last-Event-ID`.

Boot rejects combinations that cannot work: a fan-out that crosses instances
with `DC_STORE=memory` (`store_not_shared`), `postgres` without the Postgres
store (`fanout_needs_postgres`), and `DC_WORKER_IN_PROCESS=off` with `local`
(`worker_needs_fanout`).

Pub/sub does not remember. An instance that was disconnected misses events, and
its browsers catch up by replaying from the store when they reconnect (the
stream sends `Last-Event-ID`, and `GET /api/events` replays what finished after
it). Streams drop repeats by `event_id`, so a fan-out may deliver an event twice.

## The interface

Export `name`, `configKeys` (`config_keys`), `validate(env)` and `create(ctx)`.
`ctx.store` is the event store.

| Method | What it does |
|---|---|
| `publish(event)` | Tell every instance, including this one, that the event finished. |
| `subscribe(handler, { afterEventId })` | Call `handler(event)` for each event. Returns an unsubscribe function. `afterEventId` is the browser's `Last-Event-ID`; a polling fan-out starts from it and the others ignore it. |
| `ready()`, `close()` | Whether it can deliver, and release connections. |

Keep one subscription to your transport per instance and share it among the
streams (the built-ins do this with a small in-process hub), not one per stream.
