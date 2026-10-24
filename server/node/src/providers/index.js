/**
 * The provider registry and loader.
 *
 * Where it sits: bootstrap.js asks `resolveProvider()` for the module behind
 * each `DC_<KIND>` setting. A value is either a built-in name or a relative
 * path to your own file; both must export the same shape.
 *
 * Built-ins have no dependencies and are imported statically, so a server
 * that does not use one never pays for it. A provider that needs an optional
 * package (oidc needs `jose`) imports it inside `create()`, only when selected.
 *
 * CONTRACT.md: "Providers".
 * What a customer changes: nothing; add a file and point `DC_<KIND>` at it.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isProviderPath } from '../config.js';
import { problem } from '../problems.js';
import { DATA_METHODS } from './data/common.js';
import { STORE_METHODS } from './store/common.js';
import * as memoryData from './data/memory.js';
import * as dynamodbData from './data/dynamodb.js';
import * as postgresData from './data/postgres.js';
import * as sqliteData from './data/sqlite.js';
import * as consoleLog from './log/console.js';
import * as dev from './identity/dev.js';
import * as oidc from './identity/oidc.js';
import * as passcode from './identity/passcode.js';
import * as localFanout from './fanout/local.js';
import * as pollFanout from './fanout/poll.js';
import * as postgresFanout from './fanout/postgres.js';
import * as redisFanout from './fanout/redis.js';
import * as memory from './ratelimit/memory.js';
import * as off from './ratelimit/off.js';
import * as redisLimiter from './ratelimit/redis.js';
import * as onepasswordSecrets from './secrets/1password.js';
import * as dopplerSecrets from './secrets/doppler.js';
import * as envSecrets from './secrets/env.js';
import * as fileSecrets from './secrets/file.js';
import * as infisicalSecrets from './secrets/infisical.js';
import * as vaultSecrets from './secrets/vault.js';
import * as awsSecretsManager from './secrets/aws-secrets-manager.js';
import * as awsSsm from './secrets/aws-ssm.js';
import * as memoryStore from './store/memory.js';
import * as dynamodbStore from './store/dynamodb.js';
import * as postgresStore from './store/postgres.js';
import * as redisStore from './store/redis.js';
import * as sqliteStore from './store/sqlite.js';
import * as bullmqWebhooks from './webhooks/bullmq.js';
import * as inlineWebhooks from './webhooks/inline.js';
import * as netlifyAsyncWebhooks from './webhooks/netlify-async.js';
import * as qstashWebhooks from './webhooks/qstash.js';
import * as sqsWebhooks from './webhooks/sqs.js';
import * as storeWebhooks from './webhooks/store.js';
import * as vercelQueueWebhooks from './webhooks/vercel-queue.js';

/** The environment variable that selects each kind of provider. */
export const KIND_VARIABLES = Object.freeze({
    identity: 'DC_IDENTITY',
    secrets: 'DC_SECRETS',
    ratelimit: 'DC_RATE_LIMIT',
    log: 'DC_LOG',
    observer: 'DC_OBSERVER',
    store: 'DC_STORE',
    fanout: 'DC_FANOUT',
    webhooks: 'DC_WEBHOOKS',
    data: 'DC_DATA'
});

/** What each kind uses when its variable is unset; observers default to none. The store, fan-out and webhook defaults shown here are the plain-local ones: config.js picks the real default from the other settings. */
export const KIND_DEFAULTS = Object.freeze({ identity: 'dev', secrets: 'env', ratelimit: 'memory', log: 'console', observer: null, store: 'memory', fanout: 'local', webhooks: 'store', data: 'memory' });

/** The built-in providers by kind and name. */
export const BUILTINS = Object.freeze({
    identity: { dev, passcode, oidc },
    secrets: {
        env: envSecrets,
        file: fileSecrets,
        doppler: dopplerSecrets,
        infisical: infisicalSecrets,
        '1password': onepasswordSecrets,
        vault: vaultSecrets,
        'aws-secrets-manager': awsSecretsManager,
        'aws-ssm': awsSsm
    },
    ratelimit: { memory, off, redis: redisLimiter },
    log: { console: consoleLog },
    observer: {},
    store: { memory: memoryStore, sqlite: sqliteStore, postgres: postgresStore, redis: redisStore, dynamodb: dynamodbStore },
    fanout: { local: localFanout, redis: redisFanout, postgres: postgresFanout, poll: pollFanout },
    webhooks: {
        store: storeWebhooks, bullmq: bullmqWebhooks, inline: inlineWebhooks, sqs: sqsWebhooks,
        'vercel-queue': vercelQueueWebhooks, 'netlify-async': netlifyAsyncWebhooks, qstash: qstashWebhooks
    },
    data: { memory: memoryData, sqlite: sqliteData, postgres: postgresData, dynamodb: dynamodbData }
});

/** The methods an instance of each kind must have (observers only need hooks, so none are required). */
export const REQUIRED_METHODS = Object.freeze({
    identity: ['authenticate'],
    secrets: ['load'],
    ratelimit: ['hit'],
    log: ['write'],
    observer: [],
    store: STORE_METHODS,
    fanout: ['publish', 'subscribe', 'ready', 'close'],
    webhooks: ['dispatch', 'start', 'stop', 'ready'],
    data: DATA_METHODS
});

/**
 * Checks a provider module has the documented shape.
 *
 * @param {unknown} mod The imported module.
 * @returns {string|null} What is wrong, or null when it is fine.
 */
export function shapeProblem(mod) {
    if (!mod || typeof mod !== 'object') return 'it exports nothing';
    if (typeof mod.name !== 'string' || mod.name === '') return 'it must export a `name` string';
    if (!Array.isArray(mod.configKeys)) return 'it must export a `configKeys` array';
    if (typeof mod.validate !== 'function') return 'it must export a `validate(env)` function';
    if (typeof mod.create !== 'function') return 'it must export a `create(ctx)` function';
    return null;
}

/**
 * Finds the module behind one `DC_<KIND>` value.
 *
 * @param {string} kind `identity`, `secrets`, `ratelimit`, `log` or `observer`.
 * @param {string|null} spec The configured value: a built-in name, a relative path, or null for none.
 * @param {string} root The starter root that relative paths are resolved against.
 * @returns {Promise<{ module: object|null, problem: object|null }>} The module (null when
 *   `spec` is null), or the boot problem that explains why it could not be loaded.
 */
export async function resolveProvider(kind, spec, root) {
    if (spec === null || spec === undefined) return { module: null, problem: null };
    const variable = KIND_VARIABLES[kind];
    if (!isProviderPath(spec)) {
        const builtin = Object.hasOwn(BUILTINS[kind], spec) ? BUILTINS[kind][spec] : null;
        if (builtin) return { module: builtin, problem: null };
        return {
            module: null,
            problem: problem('unknown_provider', variable + '=' + spec + ' is not a built-in ' + kind + ' provider.',
                'Use one of ' + Object.keys(BUILTINS[kind]).join(', ') + ', or a relative path to your own file.')
        };
    }
    const file = path.resolve(root, spec);
    let loaded;
    try {
        // A provider is the customer's own file, named in the environment, so its path is only known at run time.
        loaded = await import(pathToFileURL(file).href);
    } catch (err) {
        return {
            module: null,
            problem: problem('invalid_provider', variable + ' points at ' + spec + ', which could not be loaded: ' + (err && err.message ? err.message : 'unknown error') + '.',
                'Check the path is relative to the starter root and the file exports name, configKeys, validate and create.')
        };
    }
    const wrong = shapeProblem(loaded);
    if (wrong) {
        return {
            module: null,
            problem: problem('invalid_provider', variable + ' points at ' + spec + ', but ' + wrong + '.',
                'See docs/providers/' + kind + '.md for the shape.')
        };
    }
    return { module: loaded, problem: null };
}
