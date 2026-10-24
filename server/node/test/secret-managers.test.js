// The doppler, infisical, vault and 1password secrets providers, against
// stand-ins. Mirrors server/conformance/suite/19-secret-managers.test.js and
// server/python/tests/test_secret_managers.py: the same stand-in behaviour and
// the same expectations, so the two servers cannot drift apart.

import crypto from 'node:crypto';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { BUILTINS } from '../src/providers/index.js';
import * as onepassword from '../src/providers/secrets/1password.js';
import * as doppler from '../src/providers/secrets/doppler.js';
import * as infisical from '../src/providers/secrets/infisical.js';
import * as vault from '../src/providers/secrets/vault.js';
import { pick, validateBaseUrl } from '../src/providers/secrets/http.js';
import { checkProvider } from '../../conformance/provider/check.js';
import { startDoppler, startInfisical, startVault } from '../../conformance/lib/secret-managers.js';
import { SITE_ID, USER_ID, API_KEY, API_SECRET, WEBHOOK_SECRET } from './helpers.js';

const uuid = () => crypto.randomUUID();
const NAMES = ['DROPCOWBOY_API_KEY', 'DROPCOWBOY_API_SECRET', 'DROPCOWBOY_WEBHOOK_SECRET', 'DC_PASSCODE'];

/** What a manager holds: the three secrets, and one the starter must ignore. */
function served(webhook = WEBHOOK_SECRET) {
    return { DROPCOWBOY_API_KEY: API_KEY, DROPCOWBOY_API_SECRET: API_SECRET, DROPCOWBOY_WEBHOOK_SECRET: webhook, UNRELATED_SECRET: 'unrelated-' + uuid() };
}

const closers = [];
afterEach(async () => {
    while (closers.length) await closers.pop()();
});
const keep = (stub) => {
    closers.push(() => stub.close());
    return stub;
};

async function dopplerSetup() {
    const token = 'dp.st.' + uuid();
    const stub = keep(await startDoppler({ token, secrets: served() }));
    return { stub, env: { DC_SECRETS: 'doppler', DOPPLER_TOKEN: token, DOPPLER_API_URL: stub.url } };
}

async function infisicalSetup(options = {}) {
    const ids = { clientId: uuid(), clientSecret: 'cs-' + uuid(), projectId: uuid() };
    const stub = keep(await startInfisical({ ...ids, environment: 'prod', secrets: served(), ...options }));
    return {
        stub,
        env: { DC_SECRETS: 'infisical', INFISICAL_URL: stub.url, INFISICAL_CLIENT_ID: ids.clientId, INFISICAL_CLIENT_SECRET: ids.clientSecret, INFISICAL_PROJECT_ID: ids.projectId }
    };
}

async function vaultTokenSetup() {
    const token = 'hvs.' + uuid();
    const stub = keep(await startVault({ token, path: 'starter-crm', secrets: served() }));
    return { stub, env: { DC_SECRETS: 'vault', VAULT_ADDR: stub.url, VAULT_TOKEN: token, VAULT_PATH: 'starter-crm' } };
}

async function vaultApproleSetup() {
    const roleId = uuid();
    const secretId = 'sid-' + uuid();
    const stub = keep(await startVault({ roleId, secretId, path: 'apps/starter-crm', secrets: served() }));
    return { stub, env: { DC_SECRETS: 'vault', VAULT_ADDR: stub.url, VAULT_ROLE_ID: roleId, VAULT_SECRET_ID: secretId, VAULT_PATH: 'apps/starter-crm' } };
}

const SETUPS = {
    doppler: [doppler, dopplerSetup, 'DOPPLER_TOKEN'],
    infisical: [infisical, infisicalSetup, 'INFISICAL_CLIENT_SECRET'],
    'vault-token': [vault, vaultTokenSetup, 'VAULT_TOKEN'],
    'vault-approle': [vault, vaultApproleSetup, 'VAULT_SECRET_ID']
};

describe.each(Object.entries(SETUPS))('%s', (which, [module, setup, credential]) => {
    it('loads only the names asked for', async () => {
        const { env } = await setup();
        const values = await (await module.create({ env })).load(NAMES);
        expect(values).toEqual({ DROPCOWBOY_API_KEY: API_KEY, DROPCOWBOY_API_SECRET: API_SECRET, DROPCOWBOY_WEBHOOK_SECRET: WEBHOOK_SECRET });
    });

    it('refresh sees a rotated value', async () => {
        const { stub, env } = await setup();
        const provider = await module.create({ env });
        await provider.load(NAMES);
        stub.secrets.DROPCOWBOY_WEBHOOK_SECRET = 'rotated-' + uuid();
        expect((await provider.refresh()).DROPCOWBOY_WEBHOOK_SECRET).toBe(stub.secrets.DROPCOWBOY_WEBHOOK_SECRET);
    });

    it('an outage throws with the status and no credential', async () => {
        const { stub, env } = await setup();
        const provider = await module.create({ env });
        await provider.load(NAMES);
        stub.fail(503);
        const error = await provider.refresh().catch((err) => err);
        expect(error.message).toContain('HTTP 503');
        expect(error.message).not.toContain(env[credential]);
    });

    it('a wrong credential is a named failure', async () => {
        const { env } = await setup();
        const wrong = 'wrong-' + uuid();
        const error = await (await module.create({ env: { ...env, [credential]: wrong } })).load(NAMES).catch((err) => err);
        expect([400, 401, 403]).toContain(error.status);
        expect(error.message).not.toContain(wrong);
    });

    it('an unreachable manager is a named failure', async () => {
        const { stub, env } = await setup();
        await stub.close();
        const error = await (await module.create({ env })).load(NAMES).catch((err) => err);
        expect(error.message).toContain('could not be reached');
    });

    it('passes the conformance check', async () => {
        const { env } = await setup();
        const results = await checkProvider('secrets', which.split('-')[0], { loadConfig, root: '/x', builtins: BUILTINS, env });
        expect(results.filter((r) => !r.ok)).toEqual([]);
    });
});

describe('redirects', () => {
    it('are refused, and the target is never called', async () => {
        let followed = 0;
        const target = http.createServer((req, res) => { followed += 1; res.end('{}'); });
        await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
        const redirector = http.createServer((req, res) => {
            res.writeHead(302, { location: 'http://127.0.0.1:' + target.address().port + '/stolen' });
            res.end();
        });
        await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
        closers.push(async () => {
            redirector.closeAllConnections();
            target.closeAllConnections();
            await new Promise((resolve) => redirector.close(resolve));
            await new Promise((resolve) => target.close(resolve));
        });
        const env = { DOPPLER_TOKEN: 'dp.st.x', DOPPLER_API_URL: 'http://127.0.0.1:' + redirector.address().port };
        const error = await doppler.create({ env }).load(NAMES).catch((err) => err);
        expect(error.message).toMatch(/redirect/i);
        expect(followed).toBe(0);
    });
});

describe('sign-in handling', () => {
    it('infisical signs in again after a 401, exactly once', async () => {
        const { stub, env } = await infisicalSetup();
        const provider = infisical.create({ env });
        await provider.load(NAMES);
        expect(stub.logins).toBe(1);
        stub.revokeTokens();
        await provider.refresh();
        expect(stub.logins).toBe(2);
    });

    it('infisical signs in again once the token has expired', async () => {
        const { stub, env } = await infisicalSetup();
        let clock = 1_000_000;
        const provider = infisical.create({ env, now: () => clock });
        await provider.load(NAMES);
        await provider.refresh();
        expect(stub.logins).toBe(1);
        clock += 3600 * 1000;
        await provider.refresh();
        expect(stub.logins).toBe(2);
    });

    it('vault AppRole logs in again after a 403, exactly once', async () => {
        const { stub, env } = await vaultApproleSetup();
        const provider = vault.create({ env });
        await provider.load(NAMES);
        expect(stub.logins).toBe(1);
        stub.revokeTokens();
        await provider.refresh();
        expect(stub.logins).toBe(2);
    });

    it('vault does not retry a static token on 403', async () => {
        const { stub, env } = await vaultTokenSetup();
        const error = await vault.create({ env: { ...env, VAULT_TOKEN: 'revoked' } }).load(NAMES).catch((err) => err);
        expect(error.message).toContain('HTTP 403');
        expect(stub.requests).toHaveLength(1);
    });

    it('vault names the mount and path when the secret is missing', async () => {
        const { env } = await vaultTokenSetup();
        const error = await vault.create({ env: { ...env, VAULT_PATH: 'typo-crm' } }).load(NAMES).catch((err) => err);
        expect(error.message).toContain('secret/typo-crm');
    });

    it('vault sends the namespace header', async () => {
        const token = 'hvs.' + uuid();
        const stub = keep(await startVault({ token, path: 'starter-crm', secrets: served(), namespace: 'team-a' }));
        const env = { VAULT_ADDR: stub.url, VAULT_TOKEN: token, VAULT_PATH: 'starter-crm', VAULT_NAMESPACE: 'team-a' };
        expect((await vault.create({ env }).load(NAMES)).DROPCOWBOY_API_KEY).toBe(API_KEY);
    });
});

describe('validate', () => {
    const cases = [
        [doppler, {}, 'missing_doppler_token'],
        [doppler, { DOPPLER_TOKEN: 't', DOPPLER_API_URL: 'http://secrets.example.com' }, 'invalid_secrets_url'],
        [doppler, { DOPPLER_TOKEN: 't', DOPPLER_API_URL: 'not a url' }, 'invalid_secrets_url'],
        [doppler, { DOPPLER_TOKEN: 't', DOPPLER_API_URL: 'https://user:pw@api.example.com' }, 'invalid_secrets_url'],
        [infisical, {}, 'missing_infisical_setting'],
        [infisical, { INFISICAL_CLIENT_ID: 'a', INFISICAL_CLIENT_SECRET: 'b', INFISICAL_PROJECT_ID: 'c', INFISICAL_URL: 'http://infisical.example.com' }, 'invalid_secrets_url'],
        [vault, {}, 'missing_vault_setting'],
        [vault, { VAULT_ADDR: 'https://v.example.com', VAULT_PATH: 'p', VAULT_ROLE_ID: 'r' }, 'missing_vault_setting'],
        [vault, { VAULT_ADDR: 'https://v.example.com', VAULT_PATH: 'p', VAULT_TOKEN: 't', VAULT_ROLE_ID: 'r', VAULT_SECRET_ID: 's' }, 'invalid_vault_auth'],
        [vault, { VAULT_ADDR: 'http://v.example.com:8200', VAULT_PATH: 'p', VAULT_TOKEN: 't' }, 'invalid_secrets_url'],
        [vault, { VAULT_ADDR: 'https://v.example.com', VAULT_PATH: 'a/../b', VAULT_TOKEN: 't' }, 'invalid_vault_path'],
        [onepassword, {}, 'missing_onepassword_setting'],
        [onepassword, { OP_SERVICE_ACCOUNT_TOKEN: 't', OP_VAULT: 'a/b' }, 'invalid_onepassword_setting'],
        [onepassword, { OP_SERVICE_ACCOUNT_TOKEN: 't', OP_VAULT: 'v', OP_ITEM: 'i?x' }, 'invalid_onepassword_setting']
    ];
    it.each(cases)('reports each bad setting by its code (%#)', (module, env, code) => {
        expect(module.validate(env).map((p) => p.code)).toContain(code);
    });

    it.each(['http://localhost:9999', 'http://127.0.0.1:9999', 'http://[::1]:9999', 'https://api.doppler.com'])('accepts %s', (url) => {
        expect(validateBaseUrl('X', url)).toBeNull();
    });

    it('pick keeps only requested, non-empty strings', () => {
        expect(pick({ A: 'a', B: '', C: 3, D: 'd' }, ['A', 'B', 'C', 'E'])).toEqual({ A: 'a' });
        expect(pick({ toString: 'x' }, ['constructor'])).toEqual({});
    });
});

describe('1password', () => {
    /** A replacement SDK whose client resolves references from a map. */
    function fakeSdk(items, calls = []) {
        return {
            async createClient(config) {
                calls.push(config);
                return {
                    secrets: {
                        async resolve(reference) {
                            if (!Object.hasOwn(items, reference)) throw new Error('the secret reference could not be resolved: "' + reference + '" has no such field');
                            return items[reference];
                        }
                    }
                };
            }
        };
    }

    it('reads a field per secret from one item, and signs in with the token', async () => {
        const calls = [];
        const items = { 'op://Starter/crm/DROPCOWBOY_API_KEY': API_KEY, 'op://Starter/crm/DROPCOWBOY_API_SECRET': API_SECRET, 'op://Starter/crm/UNRELATED_SECRET': 'ignored' };
        const provider = await onepassword.create({ env: { OP_SERVICE_ACCOUNT_TOKEN: 'ops-token', OP_VAULT: 'Starter', OP_ITEM: 'crm' }, sdk: fakeSdk(items, calls) });
        expect(await provider.load(NAMES)).toEqual({ DROPCOWBOY_API_KEY: API_KEY, DROPCOWBOY_API_SECRET: API_SECRET });
        expect(calls[0].auth).toBe('ops-token');
        expect(calls[0].integrationName).toBe('Drop Cowboy Starter CRM');
    });

    it('reads one item per secret without OP_ITEM', async () => {
        const items = { 'op://Starter/DROPCOWBOY_WEBHOOK_SECRET/credential': WEBHOOK_SECRET };
        const provider = await onepassword.create({ env: { OP_SERVICE_ACCOUNT_TOKEN: 't', OP_VAULT: 'Starter' }, sdk: fakeSdk(items) });
        expect(await provider.load(NAMES)).toEqual({ DROPCOWBOY_WEBHOOK_SECRET: WEBHOOK_SECRET });
    });

    it('refresh reads the same names again', async () => {
        const items = { 'op://Starter/crm/DROPCOWBOY_WEBHOOK_SECRET': 'one' };
        const provider = await onepassword.create({ env: { OP_SERVICE_ACCOUNT_TOKEN: 't', OP_VAULT: 'Starter', OP_ITEM: 'crm' }, sdk: fakeSdk(items) });
        await provider.load(['DROPCOWBOY_WEBHOOK_SECRET']);
        items['op://Starter/crm/DROPCOWBOY_WEBHOOK_SECRET'] = 'two';
        expect(await provider.refresh()).toEqual({ DROPCOWBOY_WEBHOOK_SECRET: 'two' });
    });

    it('fails, naming the vault and item and not the token, when nothing can be read', async () => {
        const provider = await onepassword.create({ env: { OP_SERVICE_ACCOUNT_TOKEN: 'tok-secret', OP_VAULT: 'Wrong', OP_ITEM: 'crm' }, sdk: fakeSdk({}) });
        const error = await provider.load(NAMES).catch((err) => err);
        expect(error.message).toContain('vault "Wrong", item "crm"');
        expect(error.message).not.toContain('tok-secret');
    });

    it('loads the real SDK package when none is injected', async () => {
        // Protects the pinned dependency: the import must resolve and expose createClient.
        const sdk = await import('@1password/sdk');
        expect(typeof sdk.createClient).toBe('function');
    });
});

describe('boot', () => {
    const SERVER = { DC_AUTH_MODE: 'server', DROPCOWBOY_SITE_ID: SITE_ID, STARTER_CRM_USER_ID: USER_ID };

    it('takes the secrets from the manager and redacts them and the bootstrap credential', async () => {
        const { env } = await dopplerSetup();
        const booted = await bootstrap({ ...SERVER, ...env }, '/x');
        expect(booted.problems).toEqual([]);
        expect(booted.config.apiKey).toBe(API_KEY);
        expect(booted.config.webhookSecrets).toEqual([WEBHOOK_SECRET]);
        expect(booted.config.knownSecrets.has(env.DOPPLER_TOKEN)).toBe(true);
        expect(booted.config.knownSecrets.has(API_KEY)).toBe(true);
    });

    it('a failure names the provider and never the credential', async () => {
        const { env } = await dopplerSetup();
        const wrong = 'dp.st.wrong-' + uuid();
        const booted = await bootstrap({ ...SERVER, ...env, DOPPLER_TOKEN: wrong }, '/x');
        expect(booted.problems.map((p) => p.code)).toEqual(['secret_load_failed']);
        const text = booted.problems[0].message + booted.problems[0].fix;
        expect(text).toContain('doppler');
        expect(text).toContain('HTTP 401');
        expect(text).not.toContain(wrong);
    });
});
