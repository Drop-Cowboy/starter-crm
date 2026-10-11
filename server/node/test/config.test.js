import { describe, expect, it } from 'vitest';
import { publicConfig } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { API_KEY, API_SECRET, SITE_ID, USER_ID, WEBHOOK_SECRET, makeConfig } from './helpers.js';

describe('loadConfig', () => {
    it('defaults to server mode on loopback port 8080', () => {
        const { config, problems } = loadConfig({
            DROPCOWBOY_SITE_ID: SITE_ID,
            DROPCOWBOY_API_KEY: API_KEY,
            DROPCOWBOY_API_SECRET: API_SECRET,
            STARTER_CRM_USER_ID: USER_ID
        });
        expect(problems).toEqual([]);
        expect([config.mode, config.host, config.port, config.apiBase]).toEqual(['server', '127.0.0.1', 8080, 'https://api-v2.dropcowboy.com']);
    });

    it('requires only the site id in login mode', () => {
        const { problems } = loadConfig({ DC_AUTH_MODE: 'login' });
        expect(problems).toEqual(['DROPCOWBOY_SITE_ID is required when DC_AUTH_MODE=login.']);
    });

    it('names every missing variable in server mode', () => {
        const { problems } = loadConfig({ DC_AUTH_MODE: 'server' });
        const text = problems.join('\n');
        for (const name of ['DROPCOWBOY_API_KEY', 'DROPCOWBOY_API_SECRET', 'DROPCOWBOY_SITE_ID', 'STARTER_CRM_USER_ID']) {
            expect(text).toContain(name);
        }
    });

    it('requires a UUID for the starter user', () => {
        const { problems } = loadConfig({
            DC_AUTH_MODE: 'server', DROPCOWBOY_API_KEY: 'k', DROPCOWBOY_API_SECRET: 's',
            DROPCOWBOY_SITE_ID: SITE_ID, STARTER_CRM_USER_ID: 'user-1'
        });
        expect(problems).toEqual(['STARTER_CRM_USER_ID must be a UUID.']);
    });

    it.each(['login', 'server', 'mcp-session'])('rejects a non-UUID site id in %s mode, naming invalid_site_id', (mode) => {
        const { problems } = loadConfig({
            DC_AUTH_MODE: mode, DROPCOWBOY_API_KEY: 'k', DROPCOWBOY_API_SECRET: 's',
            DROPCOWBOY_SITE_ID: 'my-site', STARTER_CRM_USER_ID: USER_ID
        });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(/^DROPCOWBOY_SITE_ID must be a UUID/);
        expect(problems[0]).toContain('400 invalid_site_id');
    });

    it('accepts a UUID site id of any version', () => {
        const { problems } = loadConfig({
            DC_AUTH_MODE: 'login', DROPCOWBOY_SITE_ID: '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
        });
        expect(problems).toEqual([]);
    });

    it('rejects an unknown mode without echoing secrets', () => {
        const { problems } = loadConfig({ DC_AUTH_MODE: 'open', DROPCOWBOY_API_SECRET: API_SECRET });
        expect(problems).toHaveLength(1);
        expect(problems[0]).not.toContain(API_SECRET);
    });
});

describe('publicConfig', () => {
    it('never contains a secret', () => {
        for (const mode of ['login', 'server', 'mcp-session']) {
            const text = JSON.stringify(publicConfig(makeConfig({ DC_AUTH_MODE: mode })));
            for (const secret of [API_KEY, API_SECRET, WEBHOOK_SECRET]) {
                expect(text).not.toContain(secret);
            }
        }
    });

    it('includes Auth0 settings only in login mode', () => {
        expect(publicConfig(makeConfig({ DC_AUTH_MODE: 'login' })).auth0).toEqual({
            domain: 'login.dropcowboy.com', client_id: null, audience: 'https://api-v2.dropcowboy.com'
        });
        expect(publicConfig(makeConfig()).auth0).toBeNull();
    });
});
