import { describe, expect, it } from 'vitest';
import { publicConfig } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { API_KEY, API_SECRET, SITE_ID, USER_ID, WEBHOOK_SECRET, makeConfig } from './helpers.js';

function messages(problems) {
    return problems.map((p) => p.message);
}

describe('loadConfig', () => {
    it('defaults to server mode on loopback port 8080', () => {
        const { config, problems } = loadConfig({
            DROPCOWBOY_SITE_ID: SITE_ID,
            DROPCOWBOY_API_KEY: API_KEY,
            DROPCOWBOY_API_SECRET: API_SECRET,
            STARTER_CRM_USER_ID: USER_ID
        });
        expect(problems).toEqual([]);
        expect([config.mode, config.host, config.port, config.apiBase, config.env, config.identity])
            .toEqual(['server', '127.0.0.1', 8080, 'https://api-v2.dropcowboy.com', 'development', 'dev']);
    });

    it('requires only the site id in login mode', () => {
        const { problems } = loadConfig({ DC_AUTH_MODE: 'login' });
        expect(messages(problems)).toEqual(['DROPCOWBOY_SITE_ID is required when DC_AUTH_MODE=login.']);
    });

    it('names every missing variable in server mode', () => {
        const { problems } = loadConfig({ DC_AUTH_MODE: 'server' });
        const text = messages(problems).join('\n');
        for (const name of ['DROPCOWBOY_API_KEY', 'DROPCOWBOY_API_SECRET', 'DROPCOWBOY_SITE_ID', 'STARTER_CRM_USER_ID']) {
            expect(text).toContain(name);
        }
    });

    it('requires a UUID for the starter user', () => {
        const { problems } = loadConfig({
            DC_AUTH_MODE: 'server', DROPCOWBOY_API_KEY: 'k', DROPCOWBOY_API_SECRET: 's',
            DROPCOWBOY_SITE_ID: SITE_ID, STARTER_CRM_USER_ID: 'user-1'
        });
        expect(messages(problems)).toEqual(['STARTER_CRM_USER_ID must be a UUID.']);
    });

    it.each(['login', 'server', 'mcp-session'])('rejects a non-UUID site id in %s mode, naming invalid_site_id', (mode) => {
        const { problems } = loadConfig({
            DC_AUTH_MODE: mode, DROPCOWBOY_API_KEY: 'k', DROPCOWBOY_API_SECRET: 's',
            DROPCOWBOY_SITE_ID: 'my-site', STARTER_CRM_USER_ID: USER_ID
        });
        expect(problems).toHaveLength(1);
        expect(problems[0].message).toMatch(/^DROPCOWBOY_SITE_ID must be a UUID/);
        expect(problems[0].message).toContain('400 invalid_site_id');
        expect(problems[0].code).toBe('invalid_site_id');
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
        expect(problems[0].message).not.toContain(API_SECRET);
        expect(problems[0].code).toBe('invalid_auth_mode');
    });

    it('refuses SAMPLE_USER_ID and names STARTER_CRM_USER_ID', () => {
        const { problems } = loadConfig({
            DC_AUTH_MODE: 'server',
            DROPCOWBOY_API_KEY: API_KEY,
            DROPCOWBOY_API_SECRET: API_SECRET,
            DROPCOWBOY_SITE_ID: SITE_ID,
            STARTER_CRM_USER_ID: USER_ID,
            SAMPLE_USER_ID: USER_ID
        });
        expect(problems.some((p) => p.code === 'renamed_env' && p.message.includes('STARTER_CRM_USER_ID'))).toBe(true);
    });

    it('refuses DC_IDENTITY=dev when DC_ENV=production with a fix hint', () => {
        const { problems } = loadConfig({
            DC_ENV: 'production',
            DC_IDENTITY: 'dev',
            DC_AUTH_MODE: 'server',
            DROPCOWBOY_API_KEY: API_KEY,
            DROPCOWBOY_API_SECRET: API_SECRET,
            DROPCOWBOY_SITE_ID: SITE_ID,
            STARTER_CRM_USER_ID: USER_ID
        });
        const hit = problems.find((p) => p.code === 'production_dev_identity');
        expect(hit).toBeTruthy();
        expect(hit.fix.length).toBeGreaterThan(10);
        expect(hit.docs).toContain('production_dev_identity');
    });

    it('refuses mcp-session when DC_ENV=production', () => {
        const { problems } = loadConfig({
            DC_ENV: 'production',
            DC_AUTH_MODE: 'mcp-session',
            DROPCOWBOY_SITE_ID: SITE_ID
        });
        expect(problems.some((p) => p.code === 'production_mcp_session')).toBe(true);
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

describe('loadConfig: Phase 2 settings', () => {
    const base = {
        DC_AUTH_MODE: 'server',
        DROPCOWBOY_API_KEY: API_KEY,
        DROPCOWBOY_API_SECRET: API_SECRET,
        DROPCOWBOY_SITE_ID: SITE_ID,
        STARTER_CRM_USER_ID: USER_ID
    };
    const codes = (extra) => loadConfig({ ...base, ...extra }).problems.map((p) => p.code);

    it('has working defaults', () => {
        const { config, problems } = loadConfig(base);
        expect(problems).toEqual([]);
        expect(config.identityKind).toBe('dev');
        expect([config.rateLimit, config.tokenCache, config.csp, config.logFormat, config.logRequests])
            .toEqual(['memory', true, 'report-only', 'pretty', false]);
        expect(config.corsOrigins).toEqual([]);
    });

    it('turns on json logs and access lines in production', () => {
        const { config } = loadConfig({ ...base, DC_ENV: 'production', DC_IDENTITY: 'passcode', DC_PASSCODE: 'a-long-enough-passcode' });
        expect([config.logFormat, config.logRequests]).toEqual(['json', true]);
    });

    it('reports one code per bad setting', () => {
        expect(codes({ DC_IDENTITY: 'bogus' })).toContain('invalid_identity');
        expect(codes({ DC_LOG_FORMAT: 'xml' })).toContain('invalid_log_format');
        expect(codes({ DC_LOG_REQUESTS: 'maybe' })).toContain('invalid_log_requests');
        expect(codes({ DC_CSP: 'sometimes' })).toContain('invalid_csp');
        expect(codes({ DC_CORS_ORIGINS: '*' })).toContain('invalid_cors_origins');
        expect(codes({ DC_CORS_ORIGINS: 'https://ok.example.com/path' })).toContain('invalid_cors_origins');
        expect(codes({ DC_RATE_LIMIT: 'distributed' })).toContain('invalid_rate_limit');
        expect(codes({ DC_TOKEN_CACHE: 'maybe' })).toContain('invalid_token_cache');
        expect(codes({ DC_SECRETS: 'nonexistent' })).toContain('invalid_secrets_provider');
        expect(codes({ DC_SECRETS_REFRESH_SECONDS: '-5' })).toContain('invalid_secrets_refresh');
        expect(codes({ DC_OBSERVER: 'sentry' })).toContain('invalid_observer');
    });

    it('allows http for a loopback OIDC issuer and parses a CORS list', () => {
        const { config, problems } = loadConfig({
            ...base, DC_IDENTITY: 'oidc', DC_OIDC_ISSUER: 'http://127.0.0.1:9000', DC_OIDC_AUDIENCE: 'crm',
            DC_CORS_ORIGINS: 'https://a.example.com, https://b.example.org'
        });
        expect(problems).toEqual([]);
        expect(config.corsOrigins).toEqual(['https://a.example.com', 'https://b.example.org']);
    });

    it('needs STARTER_CRM_USER_ID only for the dev identity', () => {
        const env = { ...base, DC_IDENTITY: 'passcode', DC_PASSCODE: 'a-long-enough-passcode' };
        delete env.STARTER_CRM_USER_ID;
        expect(loadConfig(env).problems).toEqual([]);
        expect(codes({ STARTER_CRM_USER_ID: '' })).toContain('missing_user_id');
    });

    it('refuses a non-dev identity outside server mode', () => {
        expect(codes({ DC_AUTH_MODE: 'login', DC_IDENTITY: 'passcode', DC_PASSCODE: 'a-long-enough-passcode' })).toContain('identity_requires_server_mode');
    });

});
