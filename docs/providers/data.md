# Module data providers

Your own modules (Deals is the example) keep their records in the **data API**.
It is a small document store: you ask for a collection by name, and it gives you
`insert`, `get`, `list`, `update` and `remove` over JSON documents. Every
document belongs to the signed-in user who made it, and a module never sees
another user's. Modules run only in server mode (`DC_AUTH_MODE=server`).

Set `DC_DATA`, or leave it empty to follow `DC_STORE`.

| Value | Keeps documents | Use it when |
|---|---|---|
| (empty) | Wherever `DC_STORE` keeps events, when that is `memory`, `sqlite`, `postgres` or `dynamodb`. | Almost always. |
| `memory` | In this process, until it restarts. | Building a module. Behaves like a database in every other way. |
| `sqlite` | In the same file as the sqlite event store (`DC_SQLITE_PATH`). | One instance on a VPS or Compose host. |
| `postgres` | In a table every instance shares (`DC_DATABASE_URL`, or `DATABASE_URL`). | More than one instance, or you already run Postgres. |
| `dynamodb` | In the same DynamoDB table as the event store (`DC_DYNAMODB_TABLE`). | You run on AWS. One table and one IAM policy cover events and modules. |
| `./path` | Wherever you choose. | Your own database. |

`DC_STORE=redis`, or an event store of your own, does not say where modules keep
data, so the server refuses to start in server mode until you set `DC_DATA`
(`data_provider_required`). A value that is none of the above is `invalid_data`.

Two sites never see each other's documents, even in one database: every row
carries the site id (`DROPCOWBOY_SITE_ID`), and so does every query.

## What a module sees

```js
const deals = ctx.data.collection('deals');          // lowercase letters, digits, underscores
const deal = await deals.insert({ title: 'Roof', stage: 'lead' });
await deals.get(deal.id);                            // the document, or null
await deals.list({ where: { stage: 'lead' }, limit: 20 });
await deals.update(deal.id, { stage: 'won' });       // returns the document, or null
await deals.remove(deal.id);                         // true, or false when there was none
```

In Python the same calls are plain method calls (`deals.list(where={"stage": "lead"})`).

A document is `{ id, owner_id, created_at, updated_at, ...yourFields }`:

- `id` is a UUID, `owner_id` is the user, and both times are ISO 8601 in UTC with
  milliseconds. The data API sets them; a module that passes them gets an error.
- Fields are JSON: strings, numbers, booleans, `null`, arrays and objects.
- `get`, `update` and `remove` of another user's id answer exactly as for an id
  that does not exist. A module cannot tell the two apart, so it cannot leak that
  a record exists.
- `list` returns the newest first, 100 by default and 500 at most.
- `where` matches fields that equal a string, a number or a boolean, and only
  when the type matches too: `{ flag: 1 }` does not match `true`. Field names are
  lowercase letters, digits and underscores. Anything else is an error, because
  the names reach SQL.
- `update` changes only the fields you pass; the rest stay.

An event handler (`onEvent`) gets `ctx.data` over **every** user instead, since
no one is signed in: `ctx.data.collection('deals').insert()` there needs an
`owner_id`. Handlers run at least once, so write them to be safe to run twice.

## DynamoDB limits

Documents are items with a native map of your fields, so numbers stay numbers.
Know the limits, which suit a starter:

- A user's `list()` reads that user's whole collection (strongly consistent),
  filters it in the server and sorts it, so it is meant for up to a few thousand
  documents per user and collection. For more, add an index on your filter
  field and query it from your own provider.
- The system view (event handlers) lists through an index, which is eventually
  consistent: a document written a moment ago may not be listed yet. Each listed
  document is re-read, so its fields are never stale.
- An item is at most 400 KB. `DC_DATA=dynamodb` has no migrations, so
  `npm run migrate:status` has nothing to report for it.

## Tables and migrations

`sqlite` and `postgres` keep documents in the `starter_crm_data` table, created
by migration `002_module_data` in `server/migrations`. Both servers read the same
files, so either can open the other's database. Migrations run at boot, under the
same lock as the event store's, and `npm run migrate:status` lists them. A
migration never edits an earlier file; to change a table, add the next number.

Back the database up. See `PRODUCTION.md`, "Backups".

## The interface

Export `name`, `configKeys` (`config_keys` in Python), `validate(env)` and
`create(ctx)`, as for every provider. The instance has:

| Method | What it does |
|---|---|
| `scope(ownerId)` | A view with `collection(name)` that only ever sees that owner's documents. |
| `system()` | A view with `collection(name)` over every owner of the site. Its `insert` needs `owner_id` in the document. |
| `ready()` | Whether the provider can serve; `/readyz` answers `503` while it cannot. |
| `close()` | Release connections. |
| `start()` | Python only, when it must connect: called once in the process that serves. |

All return promises in Node and plain values in Python. The helpers in
`server/node/src/providers/data/common.js` (`server/python/starter_crm/providers/data/common.py`)
hold the rules above, so a provider of your own agrees with the built-in ones
about field names, ordering, limits and time formats. Copy `memory.js` or
`memory.py` as a start. The cases every built-in provider passes are in
`server/node/test/data.test.js` and `server/python/tests/test_data.py`; run them
against yours.
