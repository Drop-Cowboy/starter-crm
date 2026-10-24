/**
 * Account readiness: proxies Drop Cowboy's integration checklist so the Setup
 * page works without the API key reaching the browser.
 *
 * Where it sits: browser -> `GET /api/dropcowboy/readiness` -> this file ->
 * Drop Cowboy `GET /register/public/integration-readiness`.
 *
 * CONTRACT.md: "GET /api/dropcowboy/readiness".
 * What a customer changes: nothing.
 */

import { jsonResponse } from './http.js';
import { callDropCowboy } from './upstream.js';

/**
 * Builds the readiness handler. It uses this server's API key, or in login
 * mode the signed-in user's token.
 *
 * @param {object} config Validated config.
 * @param {typeof fetch} fetchImpl The fetch to use.
 * @returns {(ctx: object) => Promise<Response>} Async handler; responses are `no-store`.
 * @throws {HttpError} Whatever callDropCowboy() throws.
 */
export function readinessRoute(config, fetchImpl) {
    return async function getReadiness(ctx) {
        const result = await callDropCowboy(config, fetchImpl, {
            method: 'GET',
            path: '/register/public/integration-readiness',
            accessToken: ctx.accessToken
        });
        return jsonResponse(200, pickReadiness(result.data), { 'cache-control': 'no-store' });
    };
}

/**
 * Keeps only what the setup page shows. Pool ids, plan ids, phone number
 * lists and integration ids stay on the server.
 *
 * @param {unknown} data The `data` member of Drop Cowboy's answer.
 * @returns {object} The allowlisted, type-checked readiness fields.
 */
export function pickReadiness(data) {
    const d = isObject(data) ? data : {};
    const byoc = isObject(d.byoc) ? d.byoc : {};
    const funds = isObject(d.funds) ? d.funds : {};
    const numbers = isObject(d.numbers) ? d.numbers : {};

    const providers = [];
    for (const p of Array.isArray(byoc.providers) ? byoc.providers : []) {
        if (isObject(p)) {
            providers.push({
                provider: typeof p.provider === 'string' ? p.provider : null,
                enabled: p.enabled === true,
                default: p.default === true
            });
        }
    }

    const allotment = {};
    for (const [product, value] of Object.entries(isObject(d.allotment) ? d.allotment : {})) {
        if (isObject(value) && typeof value.remaining === 'number' && typeof value.cap === 'number') {
            allotment[product] = { remaining: value.remaining, cap: value.cap };
        }
    }

    const nextActions = [];
    for (const action of Array.isArray(d.next_actions) ? d.next_actions : []) {
        if (typeof action === 'string') nextActions.push(action);
    }

    return {
        embed_ready: d.embed_ready === true,
        next_actions: nextActions,
        building_blocks_enabled: d.building_blocks_enabled === true,
        byoc: { connected: byoc.connected === true, providers },
        funds: { available: number(funds.available), funds_ok: funds.funds_ok === true },
        allotment,
        numbers: { count: number(numbers.count) },
        embed_resolve_contact_consent: d.embed_resolve_contact_consent === true,
        // True when the team has no carrier or no funds, so its session token
        // reaches 555 test numbers only. Accounts that predate the sandbox
        // omit it, which reads as false.
        sandbox_only: d.sandbox_only === true
    };
}

function number(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
