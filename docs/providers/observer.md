# Observers

An observer watches the server without touching its routes. Use one to send
errors to Sentry, spans to OpenTelemetry, or counters to your metrics system.
There is no built-in observer; `DC_OBSERVER` is empty by default.

Set `DC_OBSERVER=./my-observer.js` (or `./my_observer.py`).

## The hooks

Implement any of these. Each is awaited, receives one object, and an exception
inside one is caught and logged: **a hook can never change a response.**

| Hook (Python name) | Payload |
|---|---|
| `onRequest` (`on_request`) | `{ request_id, method, path, client_ip }` |
| `onResponse` (`on_response`) | `{ request_id, method, path, status, duration_ms }` |
| `onError` (`on_error`) | `{ request_id, method, path, message }`, for every `500 internal_error` |
| `onWebhook` (`on_webhook`) | `{ request_id, event_id, event, duplicate }`, for every verified delivery |
| `onTokenMinted` (`on_token_minted`) | `{ request_id, user_id, purpose, cached, expires_at }` |

Payloads never hold a token, a secret, a request body or a phone number, and
`path` has no query string.

Because hooks are awaited, a slow hook slows the request. Keep them quick, and
batch or queue inside your client if it is slow. Do not start work you do not
await: on a serverless host it can be cut off when the response is sent.

The module exports `name`, `configKeys` (`config_keys`), `validate(env)` and
`create(ctx)`, like every provider. The instance is an object with the hooks.

## Write your own

```js
export const name = 'my-observer';
export const configKeys = [];
export function validate() { return []; }

export function create(ctx) {
    return {
        async onResponse(event) {
            if (event.status >= 500) {
                await ctx.log.warn('Server error on ' + event.method + ' ' + event.path);
            }
        }
    };
}
```

[`CUSTOMIZE.md`](../../CUSTOMIZE.md) has full Sentry and OpenTelemetry recipes.

## Check it

```sh
npm run conformance:provider -- observer ./my-observer.js
python -m starter_crm.provider_check observer ./my_observer.py
```

The check calls each hook you export with a sample payload and confirms it
resolves without throwing.
