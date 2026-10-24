// The `vault` secrets provider against a real OpenBao, not the stand-in that
// suite 19 uses. OpenBao is the open-source Vault fork and speaks the same KV v2
// and AppRole API, so this proves the provider against the real wire format:
// the response envelope, the lease times, the error bodies.
//
// Start it with: docker compose -f tests/services.compose.yml up -d --wait
// When nothing answers, every test here is skipped with a notice and the run
// stays green, so a machine without Docker is not blocked. CI and the cloud
// agents start the service, so the skip is never what runs there.
//
// The address and root token are the compose file's throwaway dev values; set
// BAO_ADDR and BAO_ROOT_TOKEN to point at another dev server.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { before, describe, it } from 'node:test';
import { assertEnvelope, deliver, eventBody, sleep } from '../lib/context.js';
import { bootFails, bootServer, serverEnv } from '../lib/oneoff.js';
import { ctx } from '../lib/context.js';

const ADDR = process.env.BAO_ADDR || 'http://127.0.0.1:8200';
const ROOT = process.env.BAO_ROOT_TOKEN || 'starter-crm-dev-root';
const uuid = () => crypto.randomUUID();

let available = false;

/** One call to OpenBao's API as the root token; resolves to the parsed JSON body, or null for an empty one. */
async function bao(method, path, body) {
    const res = await fetch(ADDR + '/v1/' + path, {
        method,
        headers: { 'X-Vault-Token': ROOT, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000)
    });
    const text = await res.text();
    assert.ok(res.ok, method + ' ' + path + ' answered HTTP ' + res.status + ': ' + text);
    return text ? JSON.parse(text) : null;
}

/** The three secrets the server needs, plus one it must ignore. */
function secretsWith(webhook) {
    return {
        DROPCOWBOY_API_KEY: ctx.secrets.apiKey,
        DROPCOWBOY_API_SECRET: ctx.secrets.apiSecret,
        DROPCOWBOY_WEBHOOK_SECRET: webhook,
        UNRELATED_SECRET: 'unrelated-' + uuid()
    };
}

/** The server's environment with the three secrets removed, so only OpenBao can supply them. */
function envWithoutSecrets(extra) {
    const env = { ...serverEnv(), DC_SECRETS_REFRESH_SECONDS: '1', DC_SECRETS: 'vault', VAULT_ADDR: ADDR, ...extra };
    delete env.DROPCOWBOY_API_KEY;
    delete env.DROPCOWBOY_API_SECRET;
    delete env.DROPCOWBOY_WEBHOOK_SECRET;
    return env;
}

/** Writes a new version of the secret at `secret/<path>`. */
async function write(path, data) {
    await bao('POST', 'secret/data/' + path, { data });
}

/**
 * Creates an AppRole whose policy can read only `secret/data/<path>`, and returns its credentials.
 * `tokenTtl` is in seconds; a short one makes the provider renew its login during the test.
 */
async function appRole(path, tokenTtl) {
    const name = 'role-' + uuid().slice(0, 8);
    await bao('PUT', 'sys/policies/acl/' + name, { policy: 'path "secret/data/' + path + '" { capabilities = ["read"] }' });
    await bao('POST', 'auth/approle/role/' + name, { token_policies: [name], token_ttl: tokenTtl + 's', token_max_ttl: tokenTtl + 's' });
    const roleId = (await bao('GET', 'auth/approle/role/' + name + '/role-id')).data.role_id;
    const secretId = (await bao('POST', 'auth/approle/role/' + name + '/secret-id')).data.secret_id;
    return { roleId, secretId };
}

describe('secrets provider against a real OpenBao', () => {
    before(async () => {
        try {
            const res = await fetch(ADDR + '/v1/sys/health', { signal: AbortSignal.timeout(1500) });
            available = res.ok;
        } catch {
            available = false;
        }
        if (!available) {
            console.log('# OpenBao is not reachable at ' + ADDR + '; skipping. Start it with: docker compose -f tests/services.compose.yml up -d --wait');
            return;
        }
        // The dev server mounts KV v2 at secret/ but ships with AppRole disabled.
        const methods = await bao('GET', 'sys/auth');
        if (!methods['approle/']) await bao('POST', 'sys/auth/approle', { type: 'approle' });
    });

    it('loads the secrets with a token, and ignores the rest', async (t) => {
        if (!available) return t.skip('OpenBao is not running');
        const path = 'token-' + uuid();
        const webhook = 'bao-webhook-' + uuid();
        await write(path, secretsWith(webhook));
        const server = await bootServer('bao-token', envWithoutSecrets({ VAULT_TOKEN: ROOT, VAULT_PATH: path }));
        try {
            assert.equal((await deliver('bao-token', eventBody(uuid()), { secret: webhook })).status, 200, 'the webhook secret came from OpenBao');
            assertEnvelope(await deliver('bao-token', eventBody(uuid()), { secret: 'not-the-secret' }), 401, 'invalid_signature');
            for (const value of [ROOT, webhook, ctx.secrets.apiSecret]) assert.ok(!server.output().includes(value), 'a secret or token was printed');
        } finally {
            await server.stop();
        }
    });

    it('loads the secrets with AppRole, using a policy that reads only its own path', async (t) => {
        if (!available) return t.skip('OpenBao is not running');
        const path = 'approle-' + uuid();
        const webhook = 'bao-webhook-' + uuid();
        await write(path, secretsWith(webhook));
        const { roleId, secretId } = await appRole(path, 300);
        const server = await bootServer('bao-approle', envWithoutSecrets({ VAULT_ROLE_ID: roleId, VAULT_SECRET_ID: secretId, VAULT_PATH: path }));
        try {
            assert.equal((await deliver('bao-approle', eventBody(uuid()), { secret: webhook })).status, 200);
            for (const value of [roleId, secretId, webhook]) assert.ok(!server.output().includes(value), 'a secret or credential was printed');
        } finally {
            await server.stop();
        }
    });

    it('uses a rotated value, and logs in again after the AppRole token has expired', async (t) => {
        if (!available) return t.skip('OpenBao is not running');
        const path = 'rotate-' + uuid();
        const first = 'bao-one-' + uuid();
        const second = 'bao-two-' + uuid();
        await write(path, secretsWith(first));
        // A 5-second token is gone long before the test ends, so reading the second version proves a fresh login.
        const { roleId, secretId } = await appRole(path, 5);
        const server = await bootServer('bao-rotate', envWithoutSecrets({ VAULT_ROLE_ID: roleId, VAULT_SECRET_ID: secretId, VAULT_PATH: path }));
        try {
            assert.equal((await deliver('bao-rotate', eventBody(uuid()), { secret: first })).status, 200);
            await sleep(7000);
            await write(path, secretsWith(second));
            await sleep(2600);
            assert.equal((await deliver('bao-rotate', eventBody(uuid()), { secret: second })).status, 200, 'the new version is in use after the token expired');
            assertEnvelope(await deliver('bao-rotate', eventBody(uuid()), { secret: first }), 401, 'invalid_signature');
        } finally {
            await server.stop();
        }
    });

    it('a wrong token stops the boot, and a missing path names the mount and path', async (t) => {
        if (!available) return t.skip('OpenBao is not running');
        const path = 'wrong-' + uuid();
        await write(path, secretsWith('x-' + uuid()));
        const wrong = 'wrong-token-' + uuid();
        const denied = await bootFails(envWithoutSecrets({ VAULT_TOKEN: wrong, VAULT_PATH: path }));
        assert.match(denied, /secret_load_failed/);
        assert.match(denied, /HTTP 403/);
        assert.ok(!denied.includes(wrong), 'the token was printed');

        const missing = await bootFails(envWithoutSecrets({ VAULT_TOKEN: ROOT, VAULT_PATH: 'no-such-' + uuid() }));
        assert.match(missing, /secret_load_failed/);
        assert.match(missing, /secret\/no-such-/);
    });
});
