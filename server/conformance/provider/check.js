/**
 * The provider conformance checks: a data-driven test that a provider file
 * has the documented shape and behaves the way the server relies on.
 *
 * Where it sits: `npm run conformance:provider -- <kind> <path>` runs this for
 * a Node provider, and `python -m starter_crm.provider_check <kind> <path>`
 * does the same for a Python one. The Node unit tests also run it over every
 * built-in. It loads the file the way the server does, so a provider that
 * passes here loads at boot.
 *
 * CONTRACT.md: "Providers". The shared vectors live in `vectors.json`.
 * What a customer changes: nothing; run it on your own provider before you
 * point `DC_<KIND>` at it.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The vectors both implementations share. */
export const VECTORS = JSON.parse(readFileSync(path.join(HERE, 'vectors.json'), 'utf8'));

/** The kinds of provider, and the methods an instance of each must have. */
const REQUIRED = {
    identity: ['authenticate'],
    secrets: ['load'],
    ratelimit: ['hit'],
    log: ['write'],
    observer: []
};

/** The hooks an observer may implement. */
const HOOKS = ['onRequest', 'onResponse', 'onError', 'onWebhook', 'onTokenMinted'];

/** A site id and user id used only to build a throwaway config. */
const SAMPLE_ENV = {
    DC_AUTH_MODE: 'server',
    DROPCOWBOY_API_KEY: 'check-key-0001',
    DROPCOWBOY_API_SECRET: 'check-secret-0002',
    DROPCOWBOY_SITE_ID: '3f8a2c1e-9b4d-4e7a-8c2f-1d5e6a7b8c9d',
    DROPCOWBOY_WEBHOOK_SECRET: 'check-webhook-secret-0003',
    STARTER_CRM_USER_ID: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
};

/**
 * Runs the checks on one provider file.
 *
 * @param {string} kind `identity`, `secrets`, `ratelimit`, `log` or `observer`.
 * @param {string} file Path to the provider module (absolute, or relative to the current directory), or a built-in name.
 * @param {{ env?: Record<string, string>, loadConfig: Function, root?: string, builtins?: Record<string, Record<string, object>> }} options `env` adds settings
 *   the provider reads (such as `DC_PASSCODE`); `loadConfig` is the starter's config loader, passed in so this
 *   file has no dependency on the server's source layout; `root` is the starter root.
 * @returns {Promise<Array<{ name: string, ok: boolean, detail?: string }>>} One result per check.
 */
export async function checkProvider(kind, file, options) {
    const results = [];
    const record = (name, ok, detail) => results.push(ok ? { name, ok } : { name, ok, detail });
    const guard = async (name, fn) => {
        try {
            await fn();
            record(name, true);
        } catch (err) {
            record(name, false, err && err.message ? err.message : String(err));
        }
    };
    if (!Object.hasOwn(REQUIRED, kind)) {
        record('kind', false, 'kind must be one of ' + Object.keys(REQUIRED).join(', '));
        return results;
    }

    let mod = null;
    await guard('the file loads', async () => {
        // A bare built-in name (`oidc`, `memory`) is looked up in the starter's own
        // registry, the same way the server resolves DC_<KIND>. Anything else is a file.
        const builtins = options.builtins && options.builtins[kind];
        const isPath = /[\\/]/.test(file) || /\.(?:c|m)?js$/.test(file);
        if (!isPath && builtins && Object.hasOwn(builtins, file)) {
            mod = builtins[file];
            return;
        }
        mod = await import(pathToFileURL(path.resolve(file)).href);
    });
    if (!mod) return results;

    await guard('exports name, configKeys, validate and create', () => {
        if (typeof mod.name !== 'string' || !mod.name) throw new Error('export a `name` string');
        if (!Array.isArray(mod.configKeys) || mod.configKeys.some((key) => typeof key !== 'string')) {
            throw new Error('export `configKeys` as an array of variable names');
        }
        if (typeof mod.validate !== 'function') throw new Error('export a `validate(env)` function');
        if (typeof mod.create !== 'function') throw new Error('export a `create(ctx)` function');
    });
    if (results.some((item) => !item.ok)) return results;

    const env = { ...SAMPLE_ENV, ...(options.env || {}) };

    await guard('validate(env) returns an array of { code, message } problems', async () => {
        const problems = await mod.validate(env);
        if (!Array.isArray(problems)) throw new Error('validate must return an array (empty when fine)');
        for (const item of problems) {
            if (!item || typeof item.code !== 'string' || typeof item.message !== 'string') {
                throw new Error('every problem needs a string `code` and `message`');
            }
        }
    });

    const logged = [];
    const sink = (level) => async (...args) => { logged.push({ level, text: args.join(' ') }); };
    const log = { info: sink('info'), warn: sink('warn'), error: sink('error'), access: sink('info') };
    let instance = null;
    await guard('create(ctx) returns an instance with the methods the server calls', async () => {
        const { config, problems } = options.loadConfig(env);
        if (problems.length > 0) throw new Error('the sample configuration did not load: ' + problems.map((p) => p.message).join('; '));
        instance = await mod.create({ config, env, log, root: options.root || process.cwd() });
        if (!instance || typeof instance !== 'object') throw new Error('create must return an object');
        for (const method of REQUIRED[kind]) {
            if (typeof instance[method] !== 'function') throw new Error('the instance needs a `' + method + '` function');
        }
        if (kind === 'observer' && !HOOKS.some((hook) => typeof instance[hook] === 'function')) {
            throw new Error('an observer needs at least one of ' + HOOKS.join(', '));
        }
    });
    if (!instance) return results;

    if (kind === 'ratelimit') await ratelimitChecks(instance, mod, guard);
    if (kind === 'secrets') await secretsChecks(instance, mod, guard);
    if (kind === 'log') await logChecks(instance, guard);
    if (kind === 'identity') await identityChecks(instance, mod, guard);
    if (kind === 'observer') await observerChecks(instance, guard);
    return results;
}

/**
 * Checks a rate limiter against the shared sequence.
 *
 * @param {object} instance The limiter.
 * @param {object} mod The module; `neverLimits = true` marks a limiter that deliberately allows everything.
 * @param {Function} guard Records a named check.
 * @returns {Promise<void>} Resolves when the checks have run.
 */
async function ratelimitChecks(instance, mod, guard) {
    const spec = VECTORS.ratelimit;
    if (mod.neverLimits === true) {
        await guard('hit() always allows (the module declares neverLimits)', async () => {
            for (let i = 0; i < spec.limit + 2; i++) {
                const outcome = await instance.hit(spec.key, spec.limit, spec.windowSeconds);
                if (outcome.allowed !== true) throw new Error('a neverLimits limiter must always allow');
            }
        });
        return;
    }
    await guard('hit() allows up to the limit, then refuses, with an integer Retry-After of at least 1', async () => {
        const seen = [];
        let last = null;
        for (let i = 0; i < spec.sequence.length; i++) {
            last = await instance.hit(spec.key, spec.limit, spec.windowSeconds);
            if (typeof last.allowed !== 'boolean') throw new Error('hit must return { allowed: boolean }');
            seen.push(last.allowed);
        }
        if (JSON.stringify(seen) !== JSON.stringify(spec.sequence)) {
            throw new Error('expected ' + JSON.stringify(spec.sequence) + ' but got ' + JSON.stringify(seen));
        }
        if (!Number.isInteger(last.retryAfterSeconds) || last.retryAfterSeconds < 1) {
            throw new Error('retryAfterSeconds must be an integer of at least 1');
        }
        if (typeof last.remaining !== 'number' || last.remaining < 0) throw new Error('remaining must be a number of at least 0');
    });
    await guard('keys are counted separately', async () => {
        const other = await instance.hit(spec.otherKey, spec.limit, spec.windowSeconds);
        if (!other.allowed) throw new Error('a different key must have its own window');
    });
}

/**
 * Checks a secrets provider.
 *
 * @param {object} instance The provider.
 * @param {object} mod The module (for `testVectors`).
 * @param {Function} guard Records a named check.
 * @returns {Promise<void>} Resolves when the checks have run.
 */
async function secretsChecks(instance, mod, guard) {
    await guard('load(names) returns an object of string values for the names it has', async () => {
        const values = await instance.load(['STARTER_CRM_CHECK_ABSENT_NAME']);
        if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('load must return an object');
        for (const value of Object.values(values)) {
            if (typeof value !== 'string') throw new Error('every loaded value must be a string');
        }
        if (Object.hasOwn(values, 'STARTER_CRM_CHECK_ABSENT_NAME') && values.STARTER_CRM_CHECK_ABSENT_NAME !== '') {
            throw new Error('a name the provider does not have must be left out');
        }
    });
    if (typeof instance.refresh === 'function') {
        await guard('refresh() returns the same shape as load()', async () => {
            const values = await instance.refresh();
            if (!values || typeof values !== 'object') throw new Error('refresh must return an object');
        });
    }
    for (const vector of Array.isArray(mod.testVectors) ? mod.testVectors : []) {
        await guard('testVectors: load(' + JSON.stringify(vector.names) + ')', async () => {
            const values = await instance.load(vector.names);
            for (const [name, expected] of Object.entries(vector.expect)) {
                if (values[name] !== expected) throw new Error(name + ' was not the expected value');
            }
        });
    }
}

/**
 * Checks a log provider.
 *
 * @param {object} instance The provider.
 * @param {Function} guard Records a named check.
 * @returns {Promise<void>} Resolves when the checks have run.
 */
async function logChecks(instance, guard) {
    await guard('write(record) accepts an info line and an access line without throwing', async () => {
        await instance.write({ time: new Date().toISOString(), level: 'info', message: 'check line', request_id: 'check-request' });
        await instance.write({ time: new Date().toISOString(), level: 'info', message: 'GET /x 200 1ms', request_id: 'check-request', method: 'GET', path: '/x', status: 200, duration_ms: 1 });
        await instance.write({ time: new Date().toISOString(), level: 'error', message: 'check error' });
    });
}

/**
 * Checks an identity provider.
 *
 * @param {object} instance The provider.
 * @param {object} mod The module (for `testVectors`; `alwaysSignedIn = true` marks the dev identity).
 * @param {Function} guard Records a named check.
 * @returns {Promise<void>} Resolves when the checks have run.
 */
async function identityChecks(instance, mod, guard) {
    await guard('authenticate() with no credentials returns null (or, for alwaysSignedIn, a user)', async () => {
        const found = await instance.authenticate(new Request('http://127.0.0.1/api/contacts'));
        if (mod.alwaysSignedIn === true) {
            if (!found || typeof found.id !== 'string') throw new Error('an alwaysSignedIn identity must return a user with a string id');
        } else if (found !== null) {
            throw new Error('with no credentials, return null (the server answers 401)');
        }
    });
    await guard('routes(), when present, returns { method, path, handler } entries under /api/auth/', () => {
        if (typeof instance.routes !== 'function') return;
        const routes = instance.routes();
        if (!Array.isArray(routes)) throw new Error('routes() must return an array');
        for (const route of routes) {
            if (!['GET', 'POST'].includes(route.method) || typeof route.path !== 'string' || typeof route.handler !== 'function') {
                throw new Error('each route needs a GET or POST method, a path and a handler');
            }
            if (!route.path.startsWith('/api/auth/')) throw new Error('route paths must start with /api/auth/ (got ' + route.path + ')');
        }
    });
    await guard('challenge, when present, is a string', () => {
        if (instance.challenge !== undefined && typeof instance.challenge !== 'string') throw new Error('challenge must be a string such as "Bearer"');
    });
    for (const vector of Array.isArray(mod.testVectors) ? mod.testVectors : []) {
        await guard('testVectors: ' + (vector.name || JSON.stringify(vector.headers)), async () => {
            const found = await instance.authenticate(new Request('http://127.0.0.1/api/contacts', { headers: vector.headers || {} }));
            if (vector.expect === null) {
                if (found !== null) throw new Error('expected no identity');
                return;
            }
            if (!found || typeof found.id !== 'string') throw new Error('expected an identity with a string id');
            for (const [key, value] of Object.entries(vector.expect)) {
                if (found[key] !== value) throw new Error('expected ' + key + ' = ' + value);
            }
        });
    }
}

/**
 * Checks an observer: every hook it has must accept a payload without throwing.
 *
 * @param {object} instance The observer.
 * @param {Function} guard Records a named check.
 * @returns {Promise<void>} Resolves when the checks have run.
 */
async function observerChecks(instance, guard) {
    const base = { request_id: 'check-request', method: 'GET', path: '/x' };
    const user = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
    const payloads = {
        onRequest: { ...base, client_ip: '127.0.0.1' },
        onResponse: { ...base, status: 200, duration_ms: 1 },
        onError: { ...base, message: 'check error' },
        onWebhook: { request_id: 'check-request', event_id: 'd1f3a8e2-7c4b-4f9a-9d22-9c1e2f3a4b5c', event: 'check', duplicate: false },
        onTokenMinted: { request_id: 'check-request', user_id: user, purpose: 'check', cached: false, expires_at: Date.now() + 3600000 }
    };
    for (const hook of HOOKS) {
        if (typeof instance[hook] !== 'function') continue;
        await guard(hook + '(payload) accepts the documented payload', async () => {
            await instance[hook](payloads[hook]);
        });
    }
}
