import { callDropCowboy } from './upstream.js';

// Proxies the account readiness check with this server's API key, or in
// login mode the signed-in user's token, so the /setup page works without the
// key ever reaching the browser.
export function readinessRoute(config, fetchImpl) {
    return async function getReadiness(req, res) {
        const result = await callDropCowboy(config, fetchImpl, {
            method: 'GET',
            path: '/register/public/integration-readiness',
            accessToken: req.accessToken
        });
        res.set('Cache-Control', 'no-store');
        res.json(pickReadiness(result.data));
    };
}

// Keep only what the setup page shows. Pool ids, plan ids, phone number lists
// and integration ids stay on the server.
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
        embed_resolve_contact_consent: d.embed_resolve_contact_consent === true
    };
}

function number(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
