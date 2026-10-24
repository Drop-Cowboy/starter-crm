import { AppError } from './errors.js';
import { callServer } from './server-api.js';

/**
 * Public runtime config from GET /api/config. It never holds a secret.
 * @typedef {object} StarterConfig
 * @property {'server' | 'login' | 'mcp-session'} auth_mode
 * @property {string | null} site_id
 * @property {string} api_base       Where the server mints tokens. The browser never calls it.
 * @property {string | null} cdn_version
 * @property {{ domain: string, client_id: string | null, audience: string } | null} auth0
 */

// Widgets and browser REST calls go here. It is the only host that serves the
// embed routes (/phone/embed/*) as well as /contact/public/*.
export const WIDGET_API_BASE = 'https://app-api-v2.dropcowboy.com';

export const CDN_ORIGIN = 'https://webforms.dropcowboy.com';

// The release this starter was written against. DC_CDN_VERSION overrides it.
export const DEFAULT_CDN_VERSION = '3.33.16';

/**
 * @param {{ fetch?: typeof fetch }} [options]
 * @returns {Promise<StarterConfig>}
 */
export function loadConfig(options) {
    return callServer('/api/config', options);
}

/**
 * The pinned CDN release to load widgets from. Pinning is what makes the
 * integrity hashes possible: a /latest/ file changes under you.
 * @param {StarterConfig} config
 */
export function cdnVersionFor(config) {
    const raw = (config && config.cdn_version) || DEFAULT_CDN_VERSION;
    const version = String(raw).trim().replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        throw new AppError('invalid_cdn_version', 'DC_CDN_VERSION must look like 3.33.0, not "' + raw + '".');
    }
    return version;
}
