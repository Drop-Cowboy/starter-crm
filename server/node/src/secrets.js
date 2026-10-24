/**
 * Applies secrets from a provider to the live config, and refreshes them.
 *
 * Where it sits: bootstrap.js builds one runtime when the secrets provider can
 * `refresh()`. The core calls `refreshIfDue()` at the start of each request, so
 * a rotated API key or webhook secret is picked up without a restart.
 *
 * Why lazily, on a request, instead of a timer: a timer's work is not awaited
 * by anything, and serverless hosts freeze the process between requests. Doing
 * the refresh inside a request, awaited, behaves the same on every host. The
 * cost is that the first request after the interval waits for one provider call.
 *
 * CONTRACT.md: "Providers" (secrets).
 * Env: DC_SECRETS_REFRESH_SECONDS.
 * What a customer changes: nothing.
 */

/**
 * Copies the secrets this server swaps at run time onto `config`.
 *
 * `DC_PASSCODE` is read once at boot and is not swapped here.
 *
 * @param {object} config The live config.
 * @param {Record<string, string>} values Secret name to value.
 * @returns {void}
 */
export function applySecrets(config, values) {
    if (typeof values.DROPCOWBOY_API_KEY === 'string' && values.DROPCOWBOY_API_KEY.trim()) {
        config.apiKey = values.DROPCOWBOY_API_KEY.trim();
    }
    if (typeof values.DROPCOWBOY_API_SECRET === 'string' && values.DROPCOWBOY_API_SECRET.trim()) {
        config.apiSecret = values.DROPCOWBOY_API_SECRET.trim();
    }
    if (typeof values.DROPCOWBOY_WEBHOOK_SECRET === 'string') {
        const list = values.DROPCOWBOY_WEBHOOK_SECRET.split(',').map((item) => item.trim()).filter(Boolean);
        if (list.length > 0) config.webhookSecrets = list;
    }
    // bootstrap.js creates the set; a config built by hand (a test) may not have one.
    if (!config.knownSecrets) config.knownSecrets = new Set();
    for (const value of Object.values(values)) {
        if (typeof value === 'string' && value) config.knownSecrets.add(value);
    }
}

/**
 * Builds the refresh runtime.
 *
 * @param {object} options What it needs.
 * @param {object} options.config The live config.
 * @param {{ refresh: () => Promise<Record<string, string>> }} options.instance The secrets provider instance.
 * @param {{ warn: Function }} options.log The logger.
 * @param {number} options.intervalSeconds How often to refresh; 0 never.
 * @param {() => number} [options.now] Clock, replaceable in tests.
 * @returns {{ refreshIfDue: () => Promise<void> }} The runtime.
 */
export function createSecretsRuntime({ config, instance, log, intervalSeconds, now = Date.now }) {
    let lastRefresh = now();
    let inFlight = null;

    async function refreshNow() {
        try {
            applySecrets(config, await instance.refresh());
        } catch (err) {
            // Keep serving with the last good values; never print the failure's detail unredacted.
            await log.warn('Secrets refresh failed, keeping the last good values: ' + (err && err.message ? err.message : 'unknown error'));
        }
    }

    return {
        async refreshIfDue() {
            if (intervalSeconds <= 0) return;
            if (inFlight) return inFlight;
            if (now() - lastRefresh < intervalSeconds * 1000) return;
            lastRefresh = now();
            inFlight = refreshNow();
            try {
                await inFlight;
            } finally {
                inFlight = null;
            }
        }
    };
}
