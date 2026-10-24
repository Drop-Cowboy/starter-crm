/**
 * Loads and validates environment configuration for the Node Starter CRM server.
 *
 * Where it sits: index.js and the conformance harness call loadConfig() before
 * createApp(). Nothing that talks to Drop Cowboy runs until problems is empty.
 *
 * CONTRACT.md: "Configuration" and "Boot".
 * Customers change values in `.env` (see `.env.example`); they should not need
 * to edit this file.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { problem } from './problems.js';
import { redisUrl } from './redis.js';

const MODES = ['login', 'server', 'mcp-session'];
/** The built-in identity providers; any other value must be a path to your own. */
const IDENTITIES = ['dev', 'passcode', 'oidc'];
const ENVIRONMENTS = ['development', 'production'];
const CSP_MODES = ['report-only', 'enforce', 'off'];
const LOG_FORMATS = ['pretty', 'json'];
/** The longest a secrets refresh interval may be: one day. */
const MAX_REFRESH_SECONDS = 86400;

/** The built-in `DC_SECRETS` values; providers/index.js registers a module for each of them. */
const SECRETS_PROVIDERS = Object.freeze(['env', 'file', 'doppler', 'infisical', '1password', 'vault', 'aws-secrets-manager', 'aws-ssm']);
/** The built-in `DC_STORE`, `DC_FANOUT` and `DC_WEBHOOKS` values; providers/index.js registers a module for each. */
const STORES = Object.freeze(['memory', 'sqlite', 'postgres', 'redis', 'dynamodb']);
const FANOUTS = Object.freeze(['local', 'redis', 'postgres', 'poll']);
const WEBHOOK_MODES = Object.freeze(['store', 'bullmq', 'inline', 'sqs', 'vercel-queue', 'netlify-async', 'qstash']);
/** Webhook modes whose queue calls back into this server (or a function of it), so they need no worker process. */
const PUSH_MODES = Object.freeze(['vercel-queue', 'netlify-async', 'qstash']);
/** Webhook modes that need a worker process polling a queue. */
const WORKER_MODES = Object.freeze(['bullmq', 'sqs']);
/** Longest an SSE stream may run on Vercel by default: the function limit on Hobby (300 s) less a margin for the browser to reconnect. */
const VERCEL_STREAM_SECONDS = 290;
/**
 * Longest an SSE stream may run on Netlify by default. Netlify documents 60 s for a streaming function, but a
 * Free-plan site measured in October 2026 cut every stream at 30 s, so this stays under that.
 */
const NETLIFY_STREAM_SECONDS = 25;
/** How often an idle SSE stream sends `: keepalive`. CONTRACT.md asks for at least every 30 s. */
const KEEPALIVE_SECONDS = 25;
/** The same on Netlify, which drops a streamed write that follows about 10 s of silence and ends the stream. */
const NETLIFY_KEEPALIVE_SECONDS = 5;
/** The built-in `DC_DATA` values (module documents). Redis is not one: module data needs owner-filtered queries and backups. */
const DATA_PROVIDERS = Object.freeze(['memory', 'sqlite', 'postgres', 'dynamodb']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SITE_ID_NOT_UUID = 'DROPCOWBOY_SITE_ID must be a UUID such as 3f8a2c1e-9b4d-4e7a-8c2f-1d5e6a7b8c9d '
    + '(generate one with `node -e "console.log(crypto.randomUUID())"`). Drop Cowboy rejects any other site_id with 400 invalid_site_id.';
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Whether a `DC_<KIND>` value names your own provider file rather than a built-in.
 *
 * Only relative paths count, so a typo such as `passcod` is reported as an
 * unknown built-in instead of being searched for on disk.
 *
 * @param {unknown} value The raw variable value.
 * @returns {boolean} True for `./x.js` and `../x.js`.
 */
export function isProviderPath(value) {
    return typeof value === 'string' && (value.startsWith('./') || value.startsWith('../'));
}

/**
 * The serverless platform the process runs on, from the variables each host sets itself.
 *
 * Serverless functions start and stop at the host's choice and freeze between requests, so a few
 * settings that are fine on one long-running machine cannot work there (see the guards in parseEvents()).
 *
 * Vercel sets `VERCEL` in its functions. Netlify sets `NETLIFY` only during the build, not in a running function, so
 * the Netlify entry (`server/netlify/lib/core.js`) sets it before booting the core.
 *
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @returns {'vercel'|'netlify'|null} The platform, or null on an ordinary long-running host.
 */
export function detectPlatform(env) {
    if (read(env, 'VERCEL')) return 'vercel';
    if (read(env, 'NETLIFY')) return 'netlify';
    return null;
}

/**
 * Folder that holds `.env`, `.dropcowboy/`, `shared/`, `vanilla/` and `react/dist/`.
 *
 * `STARTER_CRM_ROOT` (default: this package's starter root): override for tests.
 * Read from the real environment only, never from `.env`.
 *
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @returns {string} Absolute path of the starter root.
 */
export function starterRoot(env) {
    return read(env, 'STARTER_CRM_ROOT') || DEFAULT_ROOT;
}

/**
 * Validates `env` and returns `{ config, problems }`.
 *
 * A non-empty `problems` array means the server must not start; index.js
 * prints them with formatProblems() and exits. No problem message ever
 * contains a secret value.
 *
 * @param {NodeJS.ProcessEnv} env The process environment, after dotenv has run.
 * @param {string} [root] Starter root; tests pass a temporary folder.
 * @returns {{ config: object, problems: import('./problems.js').BootProblem[] }}
 *   The frozen-shape config plus every problem found (never just the first).
 */
export function loadConfig(env, root = starterRoot(env)) {
    const problems = [];

    // Renamed in the published starter. Fail loudly so a copied .env cannot
    // silently keep the old names.
    if (read(env, 'SAMPLE_USER_ID')) {
        problems.push(problem(
            'renamed_env',
            'SAMPLE_USER_ID was renamed to STARTER_CRM_USER_ID.',
            'Rename SAMPLE_USER_ID to STARTER_CRM_USER_ID in your .env (or unset it).'
        ));
    }
    if (read(env, 'SAMPLE_CRM_ROOT')) {
        problems.push(problem(
            'renamed_env',
            'SAMPLE_CRM_ROOT was renamed to STARTER_CRM_ROOT.',
            'Rename SAMPLE_CRM_ROOT to STARTER_CRM_ROOT in your environment (or unset it).'
        ));
    }

    const mode = read(env, 'DC_AUTH_MODE') || 'server';
    if (!MODES.includes(mode)) {
        problems.push(problem(
            'invalid_auth_mode',
            'DC_AUTH_MODE must be one of ' + MODES.join(', ') + ' (got "' + mode + '").',
            'Set DC_AUTH_MODE to server, login, or mcp-session.'
        ));
    }

    // DC_ENV (default: development): development | production.
    // Production templates set production so unsafe local defaults refuse to boot. A function host is public by
    // definition, so there the default is production too.
    const dcEnv = (read(env, 'DC_ENV') || (detectPlatform(env) ? 'production' : 'development')).toLowerCase();
    if (!ENVIRONMENTS.includes(dcEnv)) {
        problems.push(problem(
            'invalid_env',
            'DC_ENV must be one of ' + ENVIRONMENTS.join(', ') + ' (got "' + dcEnv + '").',
            'Set DC_ENV to development or production.'
        ));
    }

    // DC_IDENTITY (default: dev): who your app's user is in server mode. The
    // built-ins are dev, passcode and oidc; a ./path is your own provider.
    // Production refuses dev. The provider's own settings (DC_PASSCODE,
    // DC_OIDC_*) are checked by its validate() once its module is loaded.
    const identity = read(env, 'DC_IDENTITY') || 'dev';
    if (!IDENTITIES.includes(identity) && !isProviderPath(identity)) {
        problems.push(problem(
            'invalid_identity',
            'DC_IDENTITY must be one of ' + IDENTITIES.join(', ') + ', or a relative path to your own provider such as ./my-identity.js '
                + '(got "' + identity + '").',
            'Set DC_IDENTITY to dev, passcode or oidc, or point it at your own provider file.'
        ));
    } else if (mode !== 'server' && MODES.includes(mode) && identity !== 'dev') {
        // Server mode is the only one that uses an identity.
        problems.push(problem(
            'identity_requires_server_mode',
            'DC_IDENTITY=' + identity + ' only applies when DC_AUTH_MODE=server (this is ' + mode + ').',
            'Unset DC_IDENTITY, or set DC_AUTH_MODE=server.'
        ));
    }

    if (dcEnv === 'production' && identity === 'dev') {
        problems.push(problem(
            'production_dev_identity',
            'DC_ENV=production refuses DC_IDENTITY=dev because the placeholder '
                + 'requireUser() would hand a dialer-scoped token to anyone.',
            'For production, set DC_IDENTITY to passcode, oidc or your own provider, '
                + 'or run with DC_ENV=development locally.'
        ));
    }

    if (dcEnv === 'production' && mode === 'mcp-session') {
        problems.push(problem(
            'production_mcp_session',
            'DC_ENV=production refuses DC_AUTH_MODE=mcp-session (dev-only file handoff).',
            'Set DC_AUTH_MODE=server (or login) for production.'
        ));
    }

    const apiBase = (read(env, 'DROPCOWBOY_API_BASE') || 'https://api-v2.dropcowboy.com').replace(/\/+$/, '');
    if (!/^https?:\/\/[^/]+/.test(apiBase)) {
        problems.push(problem(
            'invalid_api_base',
            'DROPCOWBOY_API_BASE must be an http(s) URL.',
            'Set DROPCOWBOY_API_BASE to an https URL such as https://api-v2.dropcowboy.com.'
        ));
    }

    const port = Number(read(env, 'PORT') || 8080);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        problems.push(problem(
            'invalid_port',
            'PORT must be a whole number between 0 and 65535.',
            'Set PORT to a free port, for example 8080.'
        ));
    }

    const timeoutMs = Number(read(env, 'DROPCOWBOY_TIMEOUT_MS') || 10000);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        problems.push(problem(
            'invalid_timeout',
            'DROPCOWBOY_TIMEOUT_MS must be a positive whole number of milliseconds.',
            'Set DROPCOWBOY_TIMEOUT_MS to 10000, or another positive integer.'
        ));
    }

    // DC_SHUTDOWN_GRACE_SECONDS (default: 10): how long SIGTERM waits for open
    // SSE streams and in-flight requests before the process exits.
    const shutdownGraceSeconds = Number(read(env, 'DC_SHUTDOWN_GRACE_SECONDS') || 10);
    if (!Number.isInteger(shutdownGraceSeconds) || shutdownGraceSeconds < 1 || shutdownGraceSeconds > 300) {
        problems.push(problem(
            'invalid_shutdown_grace',
            'DC_SHUTDOWN_GRACE_SECONDS must be a whole number between 1 and 300.',
            'Set DC_SHUTDOWN_GRACE_SECONDS to 10, or another value from 1 to 300.'
        ));
    }

    // DC_TRUST_PROXY (default: 0): Express trust-proxy hop count. 0 means do
    // not trust X-Forwarded-* headers. Set to 1 (or more) behind a reverse proxy.
    // On Vercel the platform's proxy is exactly one hop and overwrites X-Forwarded-For, so the default is 1 there. On
    // Netlify the default stays 0: the function entry passes the client address Netlify measured (`context.ip`) as the
    // peer, and Netlify keeps what the client sent at the front of X-Forwarded-For and adds its own hop at the end.
    const trustProxyRaw = read(env, 'DC_TRUST_PROXY') || (detectPlatform(env) === 'vercel' ? '1' : '0');
    const trustProxy = Number(trustProxyRaw);
    if (!Number.isInteger(trustProxy) || trustProxy < 0 || trustProxy > 32) {
        problems.push(problem(
            'invalid_trust_proxy',
            'DC_TRUST_PROXY must be a whole number between 0 and 32 (got "' + trustProxyRaw + '").',
            'Set DC_TRUST_PROXY to 0 locally, or to 1 behind a single reverse proxy.'
        ));
    }

    // DC_PUBLIC_URL (optional): the public origin Drop Cowboy and browsers use
    // to reach this server, for example https://crm.example.com. No trailing slash.
    // doctor checks it; boot logs the webhook URL when it is set.
    // Origin only (scheme + host [:port]), no path. Trailing slashes are stripped.
    let publicUrl = read(env, 'DC_PUBLIC_URL');
    if (publicUrl) {
        try {
            const parsed = new URL(publicUrl.replace(/\/+$/, ''));
            if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
                || (parsed.pathname && parsed.pathname !== '/')) {
                throw new Error('bad public url');
            }
            publicUrl = parsed.origin;
        } catch {
            problems.push(problem(
                'invalid_public_url',
                'DC_PUBLIC_URL must be an http(s) origin such as https://crm.example.com (no path).',
                'Set DC_PUBLIC_URL to your public HTTPS origin, or leave it unset locally.'
            ));
            publicUrl = null;
        }
    }

    // DC_LOG_FORMAT (default: json in production, else pretty) and
    // DC_LOG_REQUESTS (default: on in production, else off).
    const logFormat = (read(env, 'DC_LOG_FORMAT') || (dcEnv === 'production' ? 'json' : 'pretty')).toLowerCase();
    if (!LOG_FORMATS.includes(logFormat)) {
        problems.push(problem(
            'invalid_log_format',
            'DC_LOG_FORMAT must be pretty or json (got "' + logFormat + '").',
            'Set DC_LOG_FORMAT to pretty for a readable console, or json for a log service.'
        ));
    }
    const logRequests = onOff(env, 'DC_LOG_REQUESTS', dcEnv === 'production', 'invalid_log_requests', problems);

    // DC_CSP (default: report-only): report-only | enforce | off.
    const csp = (read(env, 'DC_CSP') || 'report-only').toLowerCase();
    if (!CSP_MODES.includes(csp)) {
        problems.push(problem(
            'invalid_csp',
            'DC_CSP must be one of ' + CSP_MODES.join(', ') + ' (got "' + csp + '").',
            'Set DC_CSP to report-only while you check what the policy blocks, then enforce.'
        ));
    }

    // DC_CORS_ORIGINS (default: none, which turns CORS off).
    const corsOrigins = parseOrigins(read(env, 'DC_CORS_ORIGINS'), problems);

    // DC_RATE_LIMIT (default: redis when DC_REDIS_URL is set, else memory) and DC_TOKEN_CACHE (default: on).
    const rateLimit = read(env, 'DC_RATE_LIMIT') || (redisUrl(env) ? 'redis' : 'memory');
    if (!['memory', 'off', 'redis'].includes(rateLimit) && !isProviderPath(rateLimit)) {
        problems.push(problem(
            'invalid_rate_limit',
            'DC_RATE_LIMIT must be memory, redis, off, or a relative path to your own provider (got "' + rateLimit + '").',
            'Set DC_RATE_LIMIT to memory, redis (shared across instances, needs DC_REDIS_URL), or off to disable limits.'
        ));
    }
    const tokenCache = onOff(env, 'DC_TOKEN_CACHE', true, 'invalid_token_cache', problems);

    // DC_SECRETS (default: env), DC_SECRETS_DIR, DC_SECRETS_REFRESH_SECONDS (default: 300).
    const secretsProvider = read(env, 'DC_SECRETS') || 'env';
    if (!SECRETS_PROVIDERS.includes(secretsProvider) && !isProviderPath(secretsProvider)) {
        problems.push(problem(
            'invalid_secrets_provider',
            'DC_SECRETS must be ' + SECRETS_PROVIDERS.join(', ') + ', or a relative path to your own provider (got "' + secretsProvider + '").',
            'Set DC_SECRETS to env (the default), one of the other built-ins, or point it at your own provider file.'
        ));
    }
    const refreshSeconds = Number(read(env, 'DC_SECRETS_REFRESH_SECONDS') || 300);
    if (!Number.isInteger(refreshSeconds) || refreshSeconds < 0 || refreshSeconds > MAX_REFRESH_SECONDS) {
        problems.push(problem(
            'invalid_secrets_refresh',
            'DC_SECRETS_REFRESH_SECONDS must be a whole number from 0 to ' + MAX_REFRESH_SECONDS + '.',
            'Set DC_SECRETS_REFRESH_SECONDS to 300, or 0 to read secrets only at boot.'
        ));
    }

    // DC_LOG (default: console) and DC_OBSERVER (default: none).
    const logProvider = read(env, 'DC_LOG') || 'console';
    if (logProvider !== 'console' && !isProviderPath(logProvider)) {
        problems.push(problem(
            'invalid_log_provider',
            'DC_LOG must be console or a relative path to your own provider (got "' + logProvider + '").',
            'Set DC_LOG to console, or point it at your own log provider file.'
        ));
    }
    const observer = read(env, 'DC_OBSERVER');
    if (observer && !isProviderPath(observer)) {
        problems.push(problem(
            'invalid_observer',
            'DC_OBSERVER must be a relative path to your own observer (got "' + observer + '").',
            'Set DC_OBSERVER to a path such as ./my-observer.js, or leave it unset.'
        ));
    }

    const notices = [];
    const events = parseEvents(env, problems, notices);
    const config = {
        platform: detectPlatform(env),
        // Facts worth telling the operator at boot that are not problems, such as a fan-out that was changed for the host.
        notices,
        // Passwords inside DC_DATABASE_URL and DC_REDIS_URL, so the logger redacts them wherever they might surface.
        urlSecrets: urlPasswords(env),
        mode,
        identity,
        identityKind: mode !== 'server' ? 'dev' : isProviderPath(identity) ? 'custom' : identity,
        passcode: read(env, 'DC_PASSCODE'),
        oidc: {
            issuer: read(env, 'DC_OIDC_ISSUER'),
            audience: read(env, 'DC_OIDC_AUDIENCE'),
            jwksUrl: read(env, 'DC_OIDC_JWKS_URL')
        },
        secrets: { provider: secretsProvider, dir: read(env, 'DC_SECRETS_DIR'), refreshSeconds },
        rateLimit,
        events,
        data: parseData(env, mode, events.store, problems),
        tokenCache,
        logFormat,
        logRequests,
        logProvider,
        observer,
        csp,
        corsOrigins,
        env: dcEnv,
        root,
        host: read(env, 'HOST') || '127.0.0.1',
        port,
        apiBase,
        timeoutMs,
        shutdownGraceSeconds,
        trustProxy,
        publicUrl,
        apiKey: read(env, 'DROPCOWBOY_API_KEY'),
        apiSecret: read(env, 'DROPCOWBOY_API_SECRET'),
        siteId: read(env, 'DROPCOWBOY_SITE_ID'),
        // One secret per webhook, so a comma-separated list.
        webhookSecrets: (read(env, 'DROPCOWBOY_WEBHOOK_SECRET') || '').split(',').map((s) => s.trim()).filter(Boolean),
        starterUserId: read(env, 'STARTER_CRM_USER_ID'),
        cdnVersion: read(env, 'DC_CDN_VERSION'),
        auth0: {
            domain: read(env, 'AUTH0_DOMAIN') || 'login.dropcowboy.com',
            clientId: read(env, 'AUTH0_CLIENT_ID'),
            audience: read(env, 'AUTH0_AUDIENCE') || 'https://api-v2.dropcowboy.com'
        }
    };

    // Checked in every mode: login mode hands site_id to the browser and
    // mcp-session falls back to it, and Drop Cowboy answers 400 invalid_site_id.
    if (config.siteId && !UUID.test(config.siteId)) {
        problems.push(problem(
            'invalid_site_id',
            SITE_ID_NOT_UUID,
            'Generate a UUID with `node -e "console.log(crypto.randomUUID())"` and set DROPCOWBOY_SITE_ID.'
        ));
    }

    // Both modes that mint send it with every mint.
    if ((mode === 'server' || mode === 'login') && !config.siteId) {
        problems.push(problem(
            'missing_site_id',
            'DROPCOWBOY_SITE_ID is required when DC_AUTH_MODE=' + mode + '.',
            'Set DROPCOWBOY_SITE_ID to one UUID per deployed app and keep it stable.'
        ));
    }

    if (mode === 'server') {
        if (!config.apiKey) {
            problems.push(problem(
                'missing_api_key',
                'DROPCOWBOY_API_KEY is required when DC_AUTH_MODE=server.',
                'Create an API key under Developers > API keys and set DROPCOWBOY_API_KEY.'
            ));
        }
        if (!config.apiSecret) {
            problems.push(problem(
                'missing_api_secret',
                'DROPCOWBOY_API_SECRET is required when DC_AUTH_MODE=server.',
                'Copy the API secret shown when you created the key into DROPCOWBOY_API_SECRET.'
            ));
        }
        // Only the placeholder identity needs it: it IS the user. With passcode
        // it optionally names the one owner, and the others identify real users.
        if (!config.starterUserId && identity === 'dev') {
            problems.push(problem(
                'missing_user_id',
                'STARTER_CRM_USER_ID is required when DC_AUTH_MODE=server (it stands in for your signed-in user).',
                'Set STARTER_CRM_USER_ID to a UUID, or set DC_IDENTITY to passcode, oidc or your own provider.'
            ));
        } else if (config.starterUserId && !UUID.test(config.starterUserId)) {
            problems.push(problem(
                'invalid_user_id',
                'STARTER_CRM_USER_ID must be a UUID.',
                'Set STARTER_CRM_USER_ID to a UUID such as 8b6f4c2a-1d3e-4f5a-9b7c-0e2d4f6a8c1e.'
            ));
        }
    }

    return { config, problems };
}

/**
 * Values that must never appear in a log line or a response.
 *
 * @param {object} config The loaded config.
 * @returns {string[]} Every non-empty secret, for the logger to redact: the API key and
 *   secret, the passcode, the webhook secrets, and every value a secrets provider has loaded.
 */
export function secretValues(config) {
    const values = [config.apiKey, config.apiSecret, config.passcode, ...config.webhookSecrets, ...(config.urlSecrets || [])];
    // Everything a secrets provider ever returned, including values since rotated out.
    if (config.knownSecrets) values.push(...config.knownSecrets);
    return values.filter(Boolean);
}

/**
 * Reads one env var, trimmed, treating blank as unset so a `.env` line such
 * as `DC_PORT=` falls back to the default instead of becoming an empty string.
 *
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @param {string} name The variable to read.
 * @returns {string|null} The trimmed value, or null when unset or blank.
 */
function read(env, name) {
    const value = env[name];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

/**
 * Reads an `on`/`off` switch.
 *
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @param {string} name The variable to read.
 * @param {boolean} fallback The value when unset.
 * @param {string} code The problem code to report for anything else.
 * @param {object[]} problems Collects the problem.
 * @returns {boolean} True for `on`.
 */
function onOff(env, name, fallback, code, problems) {
    const raw = read(env, name);
    if (raw === null) return fallback;
    const value = raw.toLowerCase();
    if (value !== 'on' && value !== 'off') {
        problems.push(problem(code, name + ' must be on or off (got "' + raw + '").', 'Set ' + name + ' to on or off.'));
        return fallback;
    }
    return value === 'on';
}

/**
 * Parses `DC_CORS_ORIGINS`: exact origins only, so `*` and paths are refused.
 *
 * @param {string|null} raw The comma-separated value.
 * @param {object[]} problems Collects the problem.
 * @returns {string[]} The normalised origins; empty means CORS is off.
 */
function parseOrigins(raw, problems) {
    if (!raw) return [];
    const origins = [];
    for (const item of raw.split(',').map((part) => part.trim()).filter(Boolean)) {
        try {
            const parsed = new URL(item);
            const bare = (parsed.protocol === 'http:' || parsed.protocol === 'https:')
                && parsed.origin === item.replace(/\/+$/, '');
            if (!bare) throw new Error('not an origin');
            origins.push(parsed.origin);
        } catch {
            problems.push(problem(
                'invalid_cors_origins',
                'DC_CORS_ORIGINS must be a comma-separated list of origins such as https://crm.example.com (no path, no *). Bad entry: "'
                    + item + '".',
                'List each front-end origin exactly, or leave DC_CORS_ORIGINS empty to keep CORS off.'
            ));
        }
    }
    return origins;
}

/**
 * Reads an integer setting within a range.
 *
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @param {string} name The variable.
 * @param {number} fallback The value when unset.
 * @param {number} min The smallest allowed value.
 * @param {number} max The largest allowed value.
 * @param {string} code The problem code to report for a bad value.
 * @param {object[]} problems Collects the problem.
 * @param {string} [hint] Extra advice for the fix line.
 * @returns {number} The value, or the fallback when it was bad.
 */
function intSetting(env, name, fallback, min, max, code, problems, hint = '') {
    const raw = read(env, name);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        problems.push(problem(code, name + ' must be a whole number from ' + min + ' to ' + max + ' (got "' + raw + '").',
            'Set ' + name + ' to ' + fallback + ' or another value in range.' + (hint ? ' ' + hint : '')));
        return fallback;
    }
    return value;
}

/**
 * Collects the passwords inside the database and Redis addresses.
 *
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @returns {string[]} Each non-empty password, for redaction.
 */
function urlPasswords(env) {
    const out = [];
    for (const value of [read(env, 'DC_DATABASE_URL'), read(env, 'DATABASE_URL'), read(env, 'NETLIFY_DB_URL'), redisUrl(env)]) {
        if (!value) continue;
        try {
            const password = decodeURIComponent(new URL(value).password);
            if (password) out.push(password);
        } catch {
            // Not a URL; the store's own validation reports that.
        }
    }
    return out;
}

/**
 * Reads where module documents are kept (`DC_DATA`).
 *
 * It follows `DC_STORE` (memory, sqlite or postgres), so one setting moves everything. A Redis store or your own
 * store cannot hold documents, so server mode then needs `DC_DATA` named explicitly. Modules only run in server
 * mode (they need a signed-in user), so in the other modes the data is in memory and unused.
 *
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @param {string} mode The `DC_AUTH_MODE`.
 * @param {string} store The `DC_STORE` value.
 * @param {object[]} problems Collects every problem found.
 * @returns {{ provider: string }} The `config.data` object: the built-in name or `./path` of the provider.
 */
function parseData(env, mode, store, problems) {
    const explicit = read(env, 'DC_DATA');
    if (explicit && !DATA_PROVIDERS.includes(explicit) && !isProviderPath(explicit)) {
        problems.push(problem('invalid_data', 'DC_DATA must be ' + DATA_PROVIDERS.join(', ') + ', or a relative path to your own data provider (got "' + explicit + '").',
            'Leave DC_DATA unset to follow DC_STORE, or set it to memory, sqlite, postgres or dynamodb.'));
        return { provider: 'memory' };
    }
    if (mode !== 'server') return { provider: 'memory' };
    if (explicit) return { provider: explicit };
    if (DATA_PROVIDERS.includes(store) || !(store === 'redis' || isProviderPath(store))) return { provider: DATA_PROVIDERS.includes(store) ? store : 'memory' };
    problems.push(problem('data_provider_required', 'DC_STORE=' + store + ' cannot hold module data (the Deals page and your own modules).',
        'Set DC_DATA=postgres (with DC_DATABASE_URL), DC_DATA=dynamodb (on AWS) or DC_DATA=sqlite (one instance), or the path of your own data provider.'));
    return { provider: 'memory' };
}

/**
 * How a platform is named in a message.
 *
 * @param {'vercel'|'netlify'} platform From detectPlatform().
 * @returns {string} The name to show.
 */
function platformName(platform) {
    return platform === 'vercel' ? 'Vercel' : 'Netlify';
}

/**
 * The Postgres connection string, from the first of the variables that can hold one.
 *
 * `NETLIFY_DB_URL` is what Netlify Database sets for each deploy (the production database, or a branch of it for a
 * deploy preview); `getConnectionString()` in `@netlify/database` reads exactly this variable.
 *
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @returns {string} `DC_DATABASE_URL`, else `DATABASE_URL`, else `NETLIFY_DB_URL`, else ''.
 */
export function databaseUrl(env) {
    return read(env, 'DC_DATABASE_URL') || read(env, 'DATABASE_URL') || read(env, 'NETLIFY_DB_URL') || '';
}

/**
 * The default cap on one SSE stream, in seconds.
 *
 * @param {'vercel'|'netlify'|null} platform From detectPlatform().
 * @returns {number} 290 on Vercel, 25 on Netlify, 0 (no cap) elsewhere.
 */
function streamCapDefault(platform) {
    if (platform === 'vercel') return VERCEL_STREAM_SECONDS;
    if (platform === 'netlify') return NETLIFY_STREAM_SECONDS;
    return 0;
}

/**
 * Reads the event settings: where events are kept, how they reach other instances and browsers,
 * and how webhook handlers run. Also checks that the pieces can work together.
 *
 * @param {NodeJS.ProcessEnv} env The process environment.
 * @param {object[]} problems Collects every problem found.
 * @param {object[]} notices Collects what is worth saying but does not stop the boot.
 * @returns {object} The `config.events` object.
 */
function parseEvents(env, problems, notices) {
    const hasRedis = Boolean(redisUrl(env));
    const platform = detectPlatform(env);
    // A database the host attached (Neon's integration sets DATABASE_URL, Netlify Database sets NETLIFY_DB_URL) is the
    // store of a function host; there is no other place for events to live.
    const attachedDatabase = platform && databaseUrl(env);
    const store = read(env, 'DC_STORE') || (attachedDatabase ? 'postgres' : 'memory');
    if (!STORES.includes(store) && !isProviderPath(store)) {
        problems.push(problem('invalid_store', 'DC_STORE must be ' + STORES.join(', ') + ', or a relative path to your own store (got "' + store + '").',
            'Set DC_STORE to memory (the default), sqlite for one instance, or postgres, redis or dynamodb for several.'));
    }
    const durable = store !== 'memory';
    const shared = durable && store !== 'sqlite';

    const workerInProcess = onOff(env, 'DC_WORKER_IN_PROCESS', true, 'invalid_worker_in_process', problems);

    // A separate worker finishes events in another process, so the default fan-out must reach across processes.
    let fanoutDefault = 'local';
    if (shared || isProviderPath(store) || (durable && !workerInProcess)) fanoutDefault = hasRedis ? 'redis' : (store === 'postgres' ? 'postgres' : 'poll');
    // Serverless: every request may be a different instance, and a pooled database URL does not deliver LISTEN/NOTIFY.
    if (platform) fanoutDefault = hasRedis ? 'redis' : 'poll';
    let fanout = read(env, 'DC_FANOUT') || fanoutDefault;
    if (!FANOUTS.includes(fanout) && !isProviderPath(fanout)) {
        problems.push(problem('invalid_fanout', 'DC_FANOUT must be ' + FANOUTS.join(', ') + ', or a relative path to your own fan-out (got "' + fanout + '").',
            'Leave DC_FANOUT unset to pick the right one for your store, or set it to local, redis, postgres or poll.'));
    }
    if (platform && fanout === 'postgres') {
        notices.push('DC_FANOUT=postgres needs a direct database connection for LISTEN/NOTIFY, which pooled URLs on ' + platformName(platform)
            + ' do not give, so events are fanned out with poll instead. Set DC_REDIS_URL for push delivery.');
        fanout = 'poll';
    }

    const platformQueue = platform === 'vercel' ? 'vercel-queue' : 'netlify-async';
    const webhooksDefault = platform ? platformQueue
        : (durable && hasRedis ? 'bullmq' : (store === 'dynamodb' && read(env, 'DC_SQS_QUEUE_URL') ? 'sqs' : 'store'));
    const webhooks = read(env, 'DC_WEBHOOKS') || webhooksDefault;
    if (!WEBHOOK_MODES.includes(webhooks) && !isProviderPath(webhooks)) {
        problems.push(problem('invalid_webhooks_mode', 'DC_WEBHOOKS must be ' + WEBHOOK_MODES.join(', ') + ', or a relative path to your own mode (got "' + webhooks + '").',
            'Leave DC_WEBHOOKS unset to pick the right one, or set it to store, bullmq, sqs, vercel-queue, netlify-async, qstash or inline.'));
    }

    // Serverless hosts: a function instance lives for a request or a few minutes, so anything that keeps
    // events in one instance, or needs a process that stays up, silently loses events. Refuse at boot.
    let serverlessRefused = false;
    if (platform) {
        const where = platformName(platform);
        if (store === 'memory' || store === 'sqlite') {
            serverlessRefused = true;
            problems.push(problem('serverless_store', 'DC_STORE=' + store + ' keeps events inside one function instance, and ' + where + ' runs many and stops them at will, so events would be lost or invisible.',
                platform === 'vercel'
                    ? 'Set DC_STORE=postgres with DC_DATABASE_URL (Neon), or DC_STORE=redis with DC_REDIS_URL (Upstash).'
                    : 'Turn on Netlify Database for the site (it sets NETLIFY_DB_URL), or set DC_STORE=postgres with DC_DATABASE_URL, or DC_STORE=redis with DC_REDIS_URL (Upstash).'));
        }
        if (webhooks === 'store') {
            problems.push(problem('serverless_webhooks_store', 'DC_WEBHOOKS=store drains an outbox with a background worker, and ' + where + ' freezes the function between requests, so queued events would never be handled.',
                'Set DC_WEBHOOKS=' + platformQueue + ', or qstash (Upstash), or inline to run handlers inside the request.'));
        }
        if (WORKER_MODES.includes(webhooks) && workerInProcess) {
            problems.push(problem('serverless_worker', 'DC_WEBHOOKS=' + webhooks + ' needs a worker that polls its queue, and ' + where + ' cannot keep one running.',
                'Set DC_WEBHOOKS=' + platformQueue + ', or run `npm run worker` elsewhere and set DC_WORKER_IN_PROCESS=off here.'));
        }
        if (fanout === 'local') {
            problems.push(problem('serverless_fanout', 'DC_FANOUT=local only reaches browsers connected to the same function instance, and ' + where + ' runs many.',
                'Leave DC_FANOUT unset (poll, or redis when DC_REDIS_URL is set).'));
        }
    }

    // Combinations that cannot work. Each message says which setting to change.
    if (!durable && !serverlessRefused && ['redis', 'postgres', 'poll'].includes(fanout)) {
        problems.push(problem('store_not_shared', 'DC_FANOUT=' + fanout + ' carries events between instances, but DC_STORE=memory keeps them in one process.',
            'Set DC_STORE to postgres or redis, or set DC_FANOUT=local.'));
    }
    if (!durable && !serverlessRefused && (webhooks === 'bullmq' || webhooks === 'sqs' || PUSH_MODES.includes(webhooks))) {
        problems.push(problem('store_not_shared', 'DC_WEBHOOKS=' + webhooks + ' queues event ids, but DC_STORE=memory loses the events on restart.',
            'Set DC_STORE to postgres, redis, dynamodb or sqlite, or set DC_WEBHOOKS=store.'));
    }
    if (fanout === 'postgres' && store !== 'postgres') {
        problems.push(problem('fanout_needs_postgres', 'DC_FANOUT=postgres needs DC_STORE=postgres.',
            'Set DC_STORE=postgres, or choose DC_FANOUT=redis or poll.'));
    }
    if (!workerInProcess && !durable && webhooks !== 'inline') {
        problems.push(problem('worker_needs_shared_store', 'DC_WORKER_IN_PROCESS=off needs a store another process can read, but DC_STORE=memory is private to this one.',
            'Set DC_STORE to sqlite, postgres, redis or dynamodb, or leave DC_WORKER_IN_PROCESS on.'));
    }

    if (!workerInProcess && fanout === 'local' && webhooks !== 'inline') {
        problems.push(problem('worker_needs_fanout', 'DC_WORKER_IN_PROCESS=off finishes events in another process, but DC_FANOUT=local only reaches browsers connected to the process that finished them.',
            'Set DC_FANOUT=poll (any store), redis, or postgres, or leave DC_WORKER_IN_PROCESS on.'));
    }

    const handlersPath = read(env, 'DC_WEBHOOK_HANDLERS');
    if (handlersPath && !isProviderPath(handlersPath)) {
        problems.push(problem('invalid_webhook_handlers', 'DC_WEBHOOK_HANDLERS must be a relative path to your handlers file (got "' + handlersPath + '").',
            'Set DC_WEBHOOK_HANDLERS to a path such as ./handlers.js, or leave it unset.'));
    }

    return {
        store,
        fanout,
        webhooks,
        sqlitePath: read(env, 'DC_SQLITE_PATH') || 'data/starter-crm.sqlite',
        retentionHours: intSetting(env, 'DC_EVENT_RETENTION_HOURS', 72, 1, 8760, 'invalid_event_retention', problems),
        maxStreamSeconds: intSetting(env, 'DC_EVENTS_MAX_STREAM_SECONDS', streamCapDefault(platform), 0, 86400, 'invalid_max_stream_seconds', problems, '0 means no cap.'),
        keepaliveSeconds: platform === 'netlify' ? NETLIFY_KEEPALIVE_SECONDS : KEEPALIVE_SECONDS,
        fanoutPollMs: intSetting(env, 'DC_FANOUT_POLL_MS', 1000, 100, 60000, 'invalid_fanout_poll', problems),
        outboxPollMs: intSetting(env, 'DC_OUTBOX_POLL_MS', 1000, 100, 60000, 'invalid_outbox_poll', problems),
        maxAttempts: intSetting(env, 'DC_WEBHOOK_MAX_ATTEMPTS', 8, 1, 50, 'invalid_webhook_attempts', problems),
        handlerBudgetMs: intSetting(env, 'DC_WEBHOOK_HANDLER_BUDGET_MS', 3000, 100, 4500, 'invalid_handler_budget', problems,
            'Drop Cowboy waits 5 seconds for the acknowledgement, so it must stay under that.'),
        handlersPath,
        workerInProcess
    };
}
