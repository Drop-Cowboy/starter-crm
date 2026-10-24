// Reads and writes the starter's .env for `npm run setup`.
//
// Where it sits: imported by scripts/setup.mjs, tested by
// scripts/env-file.test.mjs. Only the plain KEY=value lines setup writes are
// understood; anything else in the file is ignored when reading.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The KEY=value pairs in a .env file's text, as a Map. Comments and blank lines are skipped. */
export function parseEnv(text) {
    const values = new Map();
    for (const line of String(text || '').split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
        if (match) values.set(match[1], match[2].trim());
    }
    return values;
}

/**
 * The settings worth carrying over when setup replaces an existing .env: the
 * site id, because a new one starts an empty inbox, and the webhook signing
 * secret, because it only exists in Drop Cowboy's dashboard.
 */
export function keptSettings(existing) {
    const siteId = existing && existing.get('DROPCOWBOY_SITE_ID');
    const webhookSecret = existing && existing.get('DROPCOWBOY_WEBHOOK_SECRET');
    return {
        siteId: siteId && UUID.test(siteId) ? siteId : '',
        webhookSecret: webhookSecret || ''
    };
}

/** The text of the .env setup writes. */
export function buildEnv({ mode, siteId, apiKey, apiSecret, userId, webhookSecret }) {
    return [
        '# Written by npm run setup. Mode 0600.',
        'DC_AUTH_MODE=' + mode,
        'DC_ENV=development',
        'DC_IDENTITY=dev',
        'DROPCOWBOY_SITE_ID=' + (siteId || ''),
        'DROPCOWBOY_API_KEY=' + (apiKey || ''),
        'DROPCOWBOY_API_SECRET=' + (apiSecret || ''),
        'STARTER_CRM_USER_ID=' + (userId || ''),
        'DROPCOWBOY_WEBHOOK_SECRET=' + (webhookSecret || ''),
        'HOST=127.0.0.1',
        'PORT=8080',
        ''
    ].join('\n');
}
