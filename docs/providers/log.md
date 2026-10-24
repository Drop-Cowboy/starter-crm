# Log providers

The server writes one record per event, and, with `DC_LOG_REQUESTS=on`, one
access line per request. A log provider is where those records go.

Set `DC_LOG`.

| Value | Goes to |
|---|---|
| `console` (default) | stdout for `info`, stderr for `warn` and `error`. |
| `./path` | Your own sink (a log service client, a file). |

`DC_LOG_FORMAT` picks the console layout: `json` (one object per line, the
default when `DC_ENV=production`) or `pretty` (the default otherwise).
`DC_LOG_REQUESTS` turns the access line on or off (on in production).

## Redaction is not optional

Records are redacted **before** a provider sees them, so a custom sink never has
to remember to. API secrets, site tokens, access tokens, the passcode and every
loaded secret become `[redacted]`; phone numbers become `[redacted-phone]` and
email addresses `[redacted-email]`. The conformance run fails if server output
contains a secret. Do not log request bodies or headers from your own code.

Every record carries the request's `request_id` when there is one, the same
value as the `X-Request-Id` response header and the error envelope.

## The interface

Export `name`, `configKeys` (`config_keys`), `validate(env)` and `create(ctx)`.
The instance has one method:

`write(record)` where `record` is `{ time, level, message, ... }` and `level` is
`info`, `warn` or `error`.

`write` may be async in Node and is awaited, so a serverless host does not
freeze with a record unsent. Keep it fast. The server also catches an exception
from `write`, so a logging failure never fails a request, but catching it
yourself lets you decide what to do with the record.

## Write your own

```js
export const name = 'my-log';
export const configKeys = ['MY_LOG_ENDPOINT'];
export function validate(env) {
    return env.MY_LOG_ENDPOINT
        ? []
        : [{ code: 'missing_log_endpoint', message: 'MY_LOG_ENDPOINT is not set.', fix: 'Set MY_LOG_ENDPOINT.', docs: '' }];
}

export function create(ctx) {
    return {
        async write(record) {
            try {
                await fetch(ctx.env.MY_LOG_ENDPOINT, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(record)
                });
            } catch {
                // A log service outage must not break a request.
            }
        }
    };
}
```

## Check it

```sh
npm run conformance:provider -- log ./my-log.js MY_LOG_ENDPOINT=https://logs.example.com
python -m starter_crm.provider_check log ./my_log.py MY_LOG_ENDPOINT=https://logs.example.com
```
