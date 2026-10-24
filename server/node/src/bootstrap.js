/**
 * Boot: loads providers and secrets, builds the config, and creates the
 * provider instances the core needs.
 *
 * Where it sits: index.js calls `bootstrap()` once. The order matters:
 * 1. Load the provider modules named by `DC_IDENTITY`, `DC_SECRETS`,
 *    `DC_RATE_LIMIT`, `DC_LOG` and `DC_OBSERVER`.
 * 2. Ask the secrets provider for every secret name, and merge what it returns
 *    over the environment, so the required-variable checks see them.
 * 3. Parse the config, then let each provider validate its own settings.
 * 4. Only when nothing is wrong, create the instances.
 * Every failure is a structured boot problem, never a stack trace, and none
 * contains a secret value.
 *
 * CONTRACT.md: "Boot", "Providers".
 * What a customer changes: nothing.
 */

import { isProviderPath, loadConfig } from './config.js';
import { loadHandlers } from './handlers.js';
import { createModules, loadModules } from './modules.js';
import { createLogger } from './log.js';
import { problem } from './problems.js';
import { createProcessor } from './processor.js';
import { BUILTINS, KIND_DEFAULTS, KIND_VARIABLES, REQUIRED_METHODS, resolveProvider } from './providers/index.js';
import { redisUrl } from './redis.js';
import { createRuntime } from './runtime.js';
import { createSecretsRuntime } from './secrets.js';

/** A provider setting whose name says it holds a credential, such as DOPPLER_TOKEN or VAULT_SECRET_ID. */
const CREDENTIAL_SETTING = /TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL/;

/** The secrets the starter itself reads, which a secrets provider is asked for by name. */
export const SECRET_NAMES = Object.freeze(['DROPCOWBOY_API_KEY', 'DROPCOWBOY_API_SECRET', 'DROPCOWBOY_WEBHOOK_SECRET', 'DC_PASSCODE',
    'DC_DATABASE_URL', 'DC_REDIS_URL', 'QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY', 'QSTASH_NEXT_SIGNING_KEY']);

/**
 * The kinds whose default depends on other settings (a Redis address makes the store, fan-out and webhook mode
 * default to Redis-backed ones), so config.js decides which one to use and bootstrap loads it afterwards.
 */
const LATE_KINDS = Object.freeze(['store', 'fanout', 'webhooks', 'data']);

/**
 * Reads a trimmed variable, treating blank as unset.
 *
 * @param {NodeJS.ProcessEnv} env The environment.
 * @param {string} name The variable.
 * @returns {string|null} The value or null.
 */
function read(env, name) {
    const value = typeof env[name] === 'string' ? env[name].trim() : '';
    return value === '' ? null : value;
}

/**
 * Makes sure a provider's problem is a complete boot problem.
 *
 * @param {unknown} item What `validate()` returned.
 * @returns {object} A boot problem with `docs` filled in.
 */
function asProblem(item) {
    const code = item && typeof item.code === 'string' ? item.code : 'invalid_provider';
    const message = item && typeof item.message === 'string' ? item.message : 'A provider reported a problem.';
    const fix = item && typeof item.fix === 'string' ? item.fix : 'See the provider\'s documentation.';
    return problem(code, message, fix);
}

/**
 * Boots the server's configuration and providers.
 *
 * @param {NodeJS.ProcessEnv} env The environment, after `.env` has been merged in.
 * @param {string} root The starter root.
 * @param {{ fetch?: typeof fetch }} [options] Test doubles.
 * @returns {Promise<{ problems: object[] } | { problems: [], config: object, log: object, identity: object|null,
 *   ratelimit: object, observer: object|null, secrets: object|null, runtime: object }>} Either every problem found, or
 *   the config and the created instances, with the event runtime (store, fan-out, processor, webhook mode).
 */
export async function bootstrap(env, root, options = {}) {
    const problems = [];
    const knownSecrets = new Set();
    const earlyFormat = read(env, 'DC_LOG_FORMAT') === 'json' || (!read(env, 'DC_LOG_FORMAT') && read(env, 'DC_ENV') === 'production');
    const earlyLog = createLogger({ webhookSecrets: [], knownSecrets }, console, { format: earlyFormat ? 'json' : 'pretty' });

    // 1. The modules. A value that is neither a built-in nor a path is left for loadConfig() to report.
    const modules = {};
    for (const kind of Object.keys(KIND_VARIABLES)) {
        if (LATE_KINDS.includes(kind)) continue;
        const spec = read(env, KIND_VARIABLES[kind]) || (kind === 'ratelimit' && redisUrl(env) ? 'redis' : KIND_DEFAULTS[kind]);
        const usable = spec === null || isProviderPath(spec) || Object.hasOwn(BUILTINS[kind], spec);
        if (!usable) continue;
        const result = await resolveProvider(kind, spec, root);
        if (result.problem) problems.push(result.problem);
        modules[kind] = result.module;
    }

    // 2. Secrets, before anything reads them. Failing early here means a missing secret is reported by name below.
    let secretsInstance = null;
    let mergedEnv = env;
    if (modules.secrets) {
        const secretProblems = safeValidate(modules.secrets, env);
        if (secretProblems.length > 0) return { problems: [...problems, ...secretProblems] };
        // The provider's own credentials come from the environment, before anything is loaded.
        // Redacting them from the first log line means an error from the manager can never echo one.
        for (const key of modules.secrets.configKeys) {
            if (CREDENTIAL_SETTING.test(key) && read(env, key)) knownSecrets.add(read(env, key));
        }
        try {
            secretsInstance = await modules.secrets.create({ config: null, env, log: earlyLog, root });
            const names = new Set(SECRET_NAMES);
            for (const kind of ['identity', 'ratelimit', 'log', 'observer']) {
                for (const key of (modules[kind] ? modules[kind].configKeys : [])) names.add(key);
            }
            const loaded = await secretsInstance.load([...names]);
            mergedEnv = { ...env };
            for (const [key, value] of Object.entries(loaded || {})) {
                if (typeof value === 'string' && value !== '') {
                    mergedEnv[key] = value;
                    knownSecrets.add(value);
                }
            }
        } catch (err) {
            return {
                problems: [...problems, problem('secret_load_failed',
                    'The secrets provider ' + modules.secrets.name + ' could not load secrets: ' + (err && err.message ? err.message : 'unknown error') + '.',
                    'Check the provider\'s settings and credentials. No secret value is shown here.')]
            };
        }
    }

    // 3. Config, then each provider's own settings.
    const loaded = loadConfig(mergedEnv, root);
    const config = loaded.config;
    config.knownSecrets = knownSecrets;
    problems.push(...loaded.problems);
    // A Redis address that arrived from the secrets provider can still turn the rate limiter to Redis.
    if (loaded.problems.length === 0 && !isProviderPath(config.rateLimit) && modules.ratelimit && modules.ratelimit.name !== config.rateLimit) {
        const result = await resolveProvider('ratelimit', config.rateLimit, root);
        if (result.problem) problems.push(result.problem);
        modules.ratelimit = result.module;
    }
    // The event providers are named by config.events, which has already worked out the defaults and combinations.
    if (loaded.problems.length === 0) {
        for (const kind of LATE_KINDS) {
            const result = await resolveProvider(kind, kind === 'data' ? config.data.provider : config.events[kind], root);
            if (result.problem) problems.push(result.problem);
            modules[kind] = result.module;
        }
    }
    for (const kind of ['identity', 'ratelimit', 'log', 'observer', ...LATE_KINDS]) {
        // Identity only matters in server mode; elsewhere a stray DC_IDENTITY is already reported.
        if (!modules[kind] || (kind === 'identity' && config.mode !== 'server')) continue;
        // Several providers can report the same thing (for example the Redis address), and it is one problem.
        for (const found of safeValidate(modules[kind], mergedEnv)) {
            if (!problems.some((seen) => seen.code === found.code && seen.message === found.message)) problems.push(found);
        }
    }
    const loadedHandlers = await loadHandlers(config);
    if (loadedHandlers.problem) {
        problems.push(problem('invalid_webhook_handlers', 'DC_WEBHOOK_HANDLERS (' + config.events.handlersPath + ') ' + loadedHandlers.problem + '.',
            'Fix the file, or unset DC_WEBHOOK_HANDLERS. See server/node/src/handlers.js for the shape.'));
    }
    // Modules need a signed-in user, so only server mode runs them.
    const loadedModules = config.mode === 'server' ? await loadModules() : { modules: [], problem: null };
    if (loadedModules.problem) {
        problems.push(problem('invalid_module', 'The modules folder is broken: ' + loadedModules.problem + '.',
            'Fix or remove that folder under server/node/src/modules/. See CUSTOMIZE.md, "Add a module".'));
    }
    if (problems.length > 0) return { problems };

    // 4. Create the instances.
    const instances = {};
    const created = async (kind, mod, extra = {}) => {
        const ctx = { config, env: mergedEnv, log: earlyLog, root, ...extra };
        try {
            const instance = await mod.create(ctx);
            const missing = REQUIRED_METHODS[kind].find((method) => !instance || typeof instance[method] !== 'function');
            if (missing) {
                problems.push(problem('invalid_provider', kind + ' provider ' + mod.name + ' did not return an object with a ' + missing + '() method.',
                    'See docs/providers/' + kind + '.md for the shape.'));
                return null;
            }
            return instance;
        } catch (err) {
            problems.push(problem('invalid_provider', kind + ' provider ' + mod.name + ' failed to start: ' + (err && err.message ? err.message : 'unknown error') + '.',
                'Check its settings and see docs/providers/' + kind + '.md.'));
            return null;
        }
    };

    instances.log = await created('log', modules.log);
    instances.ratelimit = await created('ratelimit', modules.ratelimit);
    instances.observer = modules.observer ? await created('observer', modules.observer) : null;
    instances.identity = config.mode === 'server' ? await created('identity', modules.identity, { fetch: options.fetch }) : null;
    if (problems.length > 0) return { problems };

    const log = createLogger(config, instances.log);
    const runtime = await createEventRuntime({
        config, mergedEnv, modules, created, log, handlers: loadedHandlers.handlers, loadedModules: loadedModules.modules, fetch: options.fetch, problems, root
    });
    if (problems.length > 0) return { problems };
    let secrets = null;
    if (secretsInstance && typeof secretsInstance.refresh === 'function' && config.secrets.refreshSeconds > 0) {
        secrets = createSecretsRuntime({ config, instance: secretsInstance, log, intervalSeconds: config.secrets.refreshSeconds });
    }
    return { problems: [], config, log, identity: instances.identity, ratelimit: instances.ratelimit, observer: instances.observer, secrets, runtime };
}

/**
 * Creates the store, the fan-out, the processor and the webhook mode, in the order each one needs the one before.
 *
 * @param {object} parts What bootstrap has so far.
 * @param {object} parts.config The loaded config.
 * @param {NodeJS.ProcessEnv} parts.mergedEnv The environment with loaded secrets.
 * @param {object} parts.modules The loaded provider modules by kind.
 * @param {Function} parts.created Creates an instance, recording a boot problem on failure.
 * @param {object} parts.log The logger.
 * @param {Record<string, Function>} parts.handlers The webhook handlers.
 * @param {object[]} parts.loadedModules The modules found under `src/modules/` (empty outside server mode).
 * @param {typeof fetch|undefined} parts.fetch The HTTP client modules use for `ctx.dropcowboy()`; tests replace it.
 * @param {object[]} parts.problems Collects problems; the runtime is null when any was added.
 * @param {string} parts.root The starter root.
 * @returns {Promise<object|null>} The runtime, or null after recording a problem.
 */
async function createEventRuntime({ config, mergedEnv, modules, created, log, handlers, loadedModules, fetch, problems, root }) {
    const store = await created('store', modules.store, { log, env: mergedEnv, root });
    if (!store) return null;
    const closeAll = async (...instances) => {
        for (const instance of instances) {
            if (instance && typeof instance.close === 'function') await instance.close();
        }
    };
    const data = await created('data', modules.data, { log, env: mergedEnv, root });
    if (!data) {
        await closeAll(store);
        return null;
    }
    let moduleRuntime;
    try {
        moduleRuntime = createModules(loadedModules, { data, config, log, fetch });
    } catch (err) {
        problems.push(problem('invalid_module', 'A module could not be set up: ' + (err && err.message ? err.message : 'unknown error') + '.',
            'Fix the module under server/node/src/modules/. See CUSTOMIZE.md, "Add a module".'));
        await closeAll(data, store);
        return null;
    }
    const fanout = await created('fanout', modules.fanout, { log, env: mergedEnv, root, store });
    if (!fanout) {
        await closeAll(data, store);
        return null;
    }
    const processor = createProcessor({ config, store, fanout, handlers, log, onEvent: moduleRuntime.runEventHooks });
    const dispatcher = await created('webhooks', modules.webhooks, { log, env: mergedEnv, root, store, processor });
    if (!dispatcher) {
        await closeAll(fanout, data, store);
        return null;
    }
    return createRuntime({ config, store, fanout, dispatcher, processor, log, data, modules: moduleRuntime });
}

/**
 * Runs a provider's `validate()`, turning a crash into a boot problem.
 *
 * @param {object} mod The provider module.
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
function safeValidate(mod, env) {
    try {
        const result = mod.validate(env);
        return Array.isArray(result) ? result.map(asProblem) : [];
    } catch (err) {
        return [problem('invalid_provider', 'Provider ' + mod.name + ' crashed while checking its settings: ' + (err && err.message ? err.message : 'unknown error') + '.',
            'Fix the provider, then restart.')];
    }
}
