# Event store providers

The event store keeps every webhook event the server accepts. It feeds the
activity stream (`GET /api/events`), the retry of failed handlers, and replay
after a restart. An event is written here before Drop Cowboy gets its `200`, so
an acknowledged event is never lost to a crash.

Set `DC_STORE`.

| Value | Keeps events | Use it when |
|---|---|---|
| `memory` (default) | In this process, until it restarts. | Building and trying the app. Everything else behaves as on a durable store. |
| `sqlite` | In one file, `DC_SQLITE_PATH` (default `data/starter-crm.sqlite`). | One instance on a VPS or Compose host. It is single-machine: two instances on two machines cannot share a file. A power cut can lose the most recent writes (`PRODUCTION.md`, item 12). |
| `postgres` | In a table every instance shares (`DC_DATABASE_URL`, or `DATABASE_URL`). | More than one instance, or you already run Postgres. |
| `redis` | In Redis or Valkey (`DC_REDIS_URL`). | Your only datastore is Redis (Upstash, for example). Turn on persistence and use `maxmemory-policy noeviction`. |
| `dynamodb` | In one DynamoDB table every instance shares (`DC_DYNAMODB_TABLE`, `AWS_REGION`). | You run on AWS and have no SQL database. The ECS Express template creates the table. |
| `./path` | Wherever you choose. | Your own database. |

Events expire `DC_EVENT_RETENTION_HOURS` after they finish (default 72, at most
8760), in every store. A `contact.deleted` event also removes that contact's
other events at once, and strips the contact's details from the
`contact.deleted` event itself, so deleting a contact in Drop Cowboy removes what
this app kept about them. Events still waiting for a handler are never pruned.

Two sites never see each other's events, even in one database: every row and
every Redis key carries the site id (`DROPCOWBOY_SITE_ID`).

## Tables and migrations

`sqlite` and `postgres` build their table from numbered SQL files in
`server/migrations/sqlite` and `server/migrations/postgres`. Both servers read
the same files, so either can open the other's database. They run at boot
(Postgres under transaction-scoped advisory lock `727001`, so instances
starting together never migrate at once and a pooled connection string cannot leak the lock, and SQLite inside `BEGIN IMMEDIATE`) and are recorded in
`starter_crm_migrations`. `npm run migrate:status` lists what has run and exits
`1` when something is pending.

A migration never edits an earlier file. To change the table, add the next
number.

## DynamoDB

`DC_STORE=dynamodb` needs `AWS_REGION` and credentials the AWS SDK can find (on
ECS, the task role). It has no migrations: create the table with
`deploy/aws/ecs-express.yaml`, or on a local stand-in such as dynamodb-local set
`AWS_ENDPOINT_URL` and `DC_DYNAMODB_AUTO_CREATE=on`. The table layout (`pk`,
`sk`, two indexes, time-to-live on `expires_at`) is in `server/CONTRACT.md`,
"DynamoDB"; Node and Python read each other's rows.

- The task role needs `GetItem`, `BatchGetItem`, `PutItem`, `UpdateItem`,
  `DeleteItem`, `BatchWriteItem`, `Query` and `DescribeTable` on the table and
  its indexes, and nothing else. The template grants exactly that.
- Index reads are eventually consistent (milliseconds). Workers claim an event
  with a conditional write, so a stale read can delay an event until the next
  poll but never runs it twice.
- An item is at most 400 KB. An event larger than that is refused with `503`
  and Drop Cowboy retries it; Drop Cowboy's events are far smaller.
- Without Redis the fan-out is `poll`. Add Redis (`--redis true` on
  `deploy:aws`) for push updates instead of polling.

## In production

- Postgres and Redis must use TLS when `DC_ENV=production` and the host is not
  local: `rediss://`, and `sslmode=require` (or stronger) on the Postgres URL.
  Boot refuses otherwise (`insecure_redis_url`, `insecure_database_url`). On a
  private network you control, such as a Compose project, set
  `DC_INSECURE_PRIVATE_SERVICES=on` to lift that check for both.
- The server needs the store at boot, and `/readyz` answers `503` while it
  cannot reach it, so a load balancer stops sending traffic.
- Back it up. See `PRODUCTION.md`, "Backups".

## The interface

Export `name`, `configKeys` (`config_keys` in Python), `validate(env)` and
`create(ctx)`. The instance has these methods. All return promises in Node and
plain values in Python, whose names are the snake_case forms (`mark_processed`).

| Method | What it does |
|---|---|
| `record(event, { visibleAt })` | Insert the event if its `event_id` is new, atomically. Returns `{ inserted, status }`; for a duplicate, `inserted` is `false` and `status` is where the first copy stands. `visibleAt` is when a worker may first take it. |
| `get(eventId)` | The event with `status` (`received`, `processed` or `failed`), `attempts`, `last_error` and `done_at`, or `null`. |
| `markProcessed(eventId)`, `markFailed(eventId, error)` | Finish an event. |
| `noteFailure(eventId, error, nextAttemptAt)` | Count one failed run and say when to try next. Returns the attempts so far. |
| `since({ afterEventId, limit })` | Finished events, oldest first, for replay. See the rules below. |
| `pending({ limit, leaseMs })` | Received events that are due, claimed for `leaseMs` so two workers never take the same one. Postgres uses `FOR UPDATE SKIP LOCKED`; Redis does it in one script. |
| `listFailed({ limit })`, `replay(eventId)` | The failed events, and put one back to `received`. |
| `purgeContact(contactId, keepEventId)` | Delete a contact's other events. |
| `counts()` | `{ received, processed, failed, oldest_received_age_seconds }`. |
| `prune()` | Delete finished events older than the retention. |
| `ready()`, `close()` | Whether it can serve, and release connections. |

Rules `since()` must keep, because the event stream relies on them:

- Order by when the event finished, oldest first. Return at most 200: the newest 200 when more qualify.
- With `afterEventId`, return events finished at or after that event's finish
  time minus a 5-second overlap, **excluding that event itself**. The overlap
  catches events that finished on another instance a moment before a clock edge;
  streams drop repeats by id.
- An unknown `afterEventId`, or one that has not finished, means "no cursor": return the newest events.

The same cases run against every built-in store, and your own should pass them:
`server/node/test/stores.test.js` and `server/python/tests/test_stores.py`
(they use real Postgres and Valkey when `tests/services.compose.yml` is up).
