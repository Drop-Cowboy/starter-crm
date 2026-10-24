/**
 * The one exception to "Redis and Postgres must use TLS in production".
 *
 * Where it sits: the redis helpers (redis.js) and the postgres store check the address of
 * their service, and refuse a plain connection to a remote host when `DC_ENV=production`.
 * That is right for a managed service across the internet. It is wrong for a Redis container
 * on the private network of your own Compose project, so an operator can say, once, that the
 * services are on a network they control: `DC_INSECURE_PRIVATE_SERVICES=on`. It applies to
 * both services and is off by default. Python has the same check (`tls.py`).
 *
 * CONTRACT.md: "Event store" (Production).
 * What a customer changes: nothing; set the variable only where it is true.
 */

/**
 * Whether the operator has said their Redis and Postgres sit on a private network they control, so plain connections are acceptable.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {boolean} True for `DC_INSECURE_PRIVATE_SERVICES` set to `on`, `1` or `true`.
 */
export function allowsPlaintext(env) {
    return ['on', '1', 'true'].includes(String(env.DC_INSECURE_PRIVATE_SERVICES || '').trim().toLowerCase());
}
