import { afterEach, describe, expect, it } from 'vitest';
import { createEventStore } from '../src/events.js';
import { pickReadiness } from '../src/readiness.js';
import { API_KEY, API_SECRET, fakeFetch, jsonResponse, makeConfig, startApp } from './helpers.js';

const ACCESS_TOKEN = 'unit-test-access-token-0004';

describe('GET /api/dropcowboy/readiness', () => {
    let app;
    afterEach(() => app && app.close());

    async function get(mode, headers = {}) {
        const upstream = fakeFetch(() => jsonResponse(200, { data: { embed_ready: true, pool_id: 'private-pool' } }));
        app = await startApp(makeConfig({ DC_AUTH_MODE: mode }), { fetch: upstream });
        const res = await fetch(app.url + '/api/dropcowboy/readiness', { headers });
        return { res, text: await res.text(), call: upstream.calls[0] };
    }

    it('server: proxies with the API key', async () => {
        const { res, text, call } = await get('server');
        expect(res.status).toBe(200);
        expect(JSON.parse(text).embed_ready).toBe(true);
        expect(text).not.toContain('private-pool');
        expect(call.url).toBe('https://api.example.test/register/public/integration-readiness');
        expect([call.headers['x-key'], call.headers['x-secret'], call.headers.authorization]).toEqual([API_KEY, API_SECRET, undefined]);
    });

    it('login: forwards the access token instead of the API key', async () => {
        const { res, call } = await get('login', { authorization: 'Bearer ' + ACCESS_TOKEN });
        expect(res.status).toBe(200);
        expect(call.headers.authorization).toBe('Bearer ' + ACCESS_TOKEN);
        expect(call.headers['x-key']).toBeUndefined();
    });

    it('login: answers 401 login_required without a bearer', async () => {
        const { res, text, call } = await get('login');
        expect(res.status).toBe(401);
        expect(JSON.parse(text).error.code).toBe('login_required');
        expect(call).toBeUndefined();
    });
});

describe('pickReadiness', () => {
    it('keeps only the fields the setup page shows', () => {
        const picked = pickReadiness({
            building_blocks_enabled: true,
            usage_plan: 'developer-plan',
            pool_id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b',
            byoc: {
                connected: true,
                pool_id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b',
                providers: [{ provider: 'twilio', integration_type: 'twilio', integration_id: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', enabled: true, default: true, pool_id: 'x' }]
            },
            numbers: { count: 2, items: [{ number_id: 'n', phone_number: '+13125550142', name: 'Main' }] },
            voices: { count: 1 },
            agents: { count: 0, published: 0 },
            funds: { available: 12.5, balance: 20, reserved: 7.5, funds_ok: true },
            allotment: { sms: { remaining: 90, cap: 100 }, email: { remaining: 5, cap: 5, extra: 1 }, broken: { remaining: 'x' } },
            embed_ready: true,
            next_actions: [],
            embed_resolve_contact_consent: true
        });

        expect(picked).toEqual({
            embed_ready: true,
            next_actions: [],
            building_blocks_enabled: true,
            byoc: { connected: true, providers: [{ provider: 'twilio', enabled: true, default: true }] },
            funds: { available: 12.5, funds_ok: true },
            allotment: { sms: { remaining: 90, cap: 100 }, email: { remaining: 5, cap: 5 } },
            numbers: { count: 2 },
            embed_resolve_contact_consent: true
        });
    });

    it('fills safe defaults when upstream omits fields, including the consent setting', () => {
        expect(pickReadiness(undefined)).toEqual({
            embed_ready: false,
            next_actions: [],
            building_blocks_enabled: false,
            byoc: { connected: false, providers: [] },
            funds: { available: 0, funds_ok: false },
            allotment: {},
            numbers: { count: 0 },
            embed_resolve_contact_consent: false
        });
    });
});

describe('createEventStore', () => {
    it('bounds events and seen ids, and replays after a known id', () => {
        const store = createEventStore({ maxEvents: 2, maxSeenIds: 3 });
        for (const id of ['a', 'b', 'c', 'd']) store.add({ event_id: id });

        expect(store.since(null).map((e) => e.event_id)).toEqual(['c', 'd']);
        expect(store.since('c').map((e) => e.event_id)).toEqual(['d']);
        expect(store.since('a').map((e) => e.event_id)).toEqual(['c', 'd']);
        expect(store.hasSeen('a')).toBe(false);
        expect(store.hasSeen('b')).toBe(true);
    });

    it('notifies subscribers until they unsubscribe', () => {
        const store = createEventStore();
        const got = [];
        const unsubscribe = store.subscribe((e) => got.push(e.event_id));
        store.add({ event_id: 'a' });
        unsubscribe();
        store.add({ event_id: 'b' });
        expect(got).toEqual(['a']);
    });
});
