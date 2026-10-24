# Rate-limit providers

A rate limiter protects the routes an attacker would hammer: the token route
(`POST /api/dropcowboy/token`), passcode sign-in and the dev session route.
Over a limit the answer is `429 rate_limited` with a `Retry-After` of at least
one second. Webhooks are never limited. The table of limits is in
[`server/CONTRACT.md`](../../server/CONTRACT.md) ("Rate limits").

Set `DC_RATE_LIMIT`.

| Value | Counts | Use it when |
|---|---|---|
| `memory` (default without Redis) | Fixed one-minute windows in this process. With Gunicorn it is per worker. | One or two long-running instances. |
| `redis` (default when `DC_REDIS_URL` is set) | Redis, one counter per key and window. | Several instances that must share one limit. If Redis is unreachable it allows the request and logs a warning, so an outage never locks users out. |
| `off` | Nothing. | Your proxy already limits, or you are testing. |
| `./path` | Wherever you keep counts. | A store other than Redis. |

`memory` stays bounded: past 10,000 keys it sweeps expired windows, and past
100,000 it drops the oldest, preferring a briefly reset counter to a crash.

The client IP is the TCP peer. Behind a reverse proxy set `DC_TRUST_PROXY=N`,
the number of proxies you trust, or every user shares the proxy's IP.

## The interface

Export `name`, `configKeys` (`config_keys` in Python), `validate(env)` and
`create(ctx)`. The instance has one method:

`hit(key, limit, windowSeconds)` records one hit and returns
`{ allowed, remaining, retryAfterSeconds }` (`retry_after_seconds` in Python).

- Count the hit, then say whether it is within `limit` for the window.
- `retryAfterSeconds` is the seconds until the window resets (`>= 1` when not allowed).
- The same `key` must share a count; different keys must not.
- If your store is down, **decide on purpose**: allowing the request (fail open)
  keeps the app up; refusing it protects Drop Cowboy. Log a warning either way.

## Write your own

```js
export const name = 'my-limiter';
export const configKeys = [];
export function validate() { return []; }

export function create(ctx) {
    const windows = new Map();
    return {
        async hit(key, limit, windowSeconds) {
            const now = Date.now();
            let window = windows.get(key);
            if (!window || window.resetAt <= now) {
                window = { count: 0, resetAt: now + windowSeconds * 1000 };
                windows.set(key, window);
            }
            window.count += 1;
            return {
                allowed: window.count <= limit,
                remaining: Math.max(0, limit - window.count),
                retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000))
            };
        }
    };
}
```

## Check it

```sh
npm run conformance:provider -- ratelimit ./my-limiter.js
python -m starter_crm.provider_check ratelimit ./my_limiter.py
```

The check replays the shared vector (limit 2, so the sequence is allowed,
allowed, refused, refused) and confirms a different key has its own count. A
limiter that allows everything on purpose (like `off`) sets `neverLimits = true`
(`never_limits` in Python) so the check expects that.
