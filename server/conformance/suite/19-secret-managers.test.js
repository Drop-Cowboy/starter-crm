// The `doppler`, `infisical` and `vault` secrets providers, against stand-ins
// for their APIs (lib/secret-managers.js). The `1password` provider uses an
// SDK, not HTTP, so it is covered by each server's own unit tests with a
// replacement SDK. A real OpenBao is exercised in suite 20.
//
// What this proves, for every provider and both servers:
// - the API key, API secret and webhook secret come from the manager alone;
// - a value rotated in the manager is in use within the refresh interval, with
//   no restart, and the old one stops working;
// - a manager outage keeps the last good values, logs a warning, and never
//   prints a value or a credential;
// - a wrong credential, a missing setting, an address that would send a
//   credential in clear text, a redirect and an unreachable manager each stop
//   the boot with a named problem.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { describe, it } from 'node:test';
import { assertEnvelope, deliver, eventBody, mockRequests, postJson, resetMock, sleep } from '../lib/context.js';
import { bootFails, bootServer, serverEnv } from '../lib/oneoff.js';
import { startAwsSecretsManager, startAwsSsm, startDoppler, startInfisical, startVault } from '../lib/secret-managers.js';
import { ctx } from '../lib/context.js';

const uuid = () => crypto.randomUUID();

/** Names a provider must be asked for; the manager also holds one it must ignore. */
function managedSecrets(webhook) {
    return {
        DROPCOWBOY_API_KEY: ctx.secrets.apiKey,
        DROPCOWBOY_API_SECRET: ctx.secrets.apiSecret,
        DROPCOWBOY_WEBHOOK_SECRET: webhook,
        UNRELATED_SECRET: 'unrelated-' + uuid()
    };
}

/** The server's environment with the three secrets removed, so only the manager can supply them. */
function envWithoutSecrets(extra) {
    const env = { ...serverEnv(), DC_SECRETS_REFRESH_SECONDS: '1', ...extra };
    delete env.DROPCOWBOY_API_KEY;
    delete env.DROPCOWBOY_API_SECRET;
    delete env.DROPCOWBOY_WEBHOOK_SECRET;
    return env;
}

// One entry per provider: how to start its stand-in, which settings point the server at it, and
// which credential a wrong one replaces.
const PROVIDERS = [
    {
        name: 'doppler',
        credential: 'DOPPLER_TOKEN',
        async start(secrets) {
            const token = 'dp.st.' + uuid();
            const stub = await startDoppler({ token, secrets });
            return { stub, env: { DC_SECRETS: 'doppler', DOPPLER_TOKEN: token, DOPPLER_API_URL: stub.url }, secretsOf: [token] };
        },
        label: 'Doppler'
    },
    {
        name: 'infisical',
        credential: 'INFISICAL_CLIENT_SECRET',
        async start(secrets, extra = {}) {
            const clientId = uuid();
            const clientSecret = 'infisical-client-secret-' + uuid();
            const projectId = uuid();
            const stub = await startInfisical({ clientId, clientSecret, projectId, environment: 'prod', secrets, ...extra });
            return {
                stub,
                env: {
                    DC_SECRETS: 'infisical', INFISICAL_URL: stub.url, INFISICAL_CLIENT_ID: clientId,
                    INFISICAL_CLIENT_SECRET: clientSecret, INFISICAL_PROJECT_ID: projectId
                },
                secretsOf: [clientSecret]
            };
        },
        label: 'Infisical'
    },
    {
        name: 'vault (token)',
        credential: 'VAULT_TOKEN',
        async start(secrets) {
            const token = 'hvs.' + uuid();
            const stub = await startVault({ token, path: 'starter-crm', secrets });
            return { stub, env: { DC_SECRETS: 'vault', VAULT_ADDR: stub.url, VAULT_TOKEN: token, VAULT_PATH: 'starter-crm' }, secretsOf: [token] };
        },
        label: 'Vault'
    },
    {
        name: 'vault (AppRole)',
        credential: 'VAULT_SECRET_ID',
        async start(secrets, extra = {}) {
            const roleId = uuid();
            const secretId = 'vault-secret-id-' + uuid();
            const stub = await startVault({ roleId, secretId, path: 'apps/starter-crm', secrets, ...extra });
            return {
                stub,
                env: { DC_SECRETS: 'vault', VAULT_ADDR: stub.url, VAULT_ROLE_ID: roleId, VAULT_SECRET_ID: secretId, VAULT_PATH: 'apps/starter-crm' },
                secretsOf: [secretId]
            };
        },
        label: 'Vault'
    },
    {
        name: 'aws-secrets-manager',
        credential: 'AWS_ACCESS_KEY_ID',
        async start(secrets) {
            const accessKeyId = 'AKIA' + uuid().replace(/-/g, '').slice(0, 16).toUpperCase();
            const secretAccessKey = 'aws-secret-key-' + uuid();
            const stub = await startAwsSecretsManager({ accessKeyId, secretId: 'starter-crm/prod', secrets });
            return {
                stub,
                env: {
                    DC_SECRETS: 'aws-secrets-manager', DC_AWS_SECRET_ID: 'starter-crm/prod', AWS_REGION: 'us-east-1',
                    AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, AWS_ENDPOINT_URL_SECRETS_MANAGER: stub.url
                },
                secretsOf: [secretAccessKey]
            };
        },
        label: 'AWS Secrets Manager'
    },
    {
        name: 'aws-ssm',
        credential: 'AWS_ACCESS_KEY_ID',
        async start(secrets) {
            const accessKeyId = 'AKIA' + uuid().replace(/-/g, '').slice(0, 16).toUpperCase();
            const secretAccessKey = 'aws-secret-key-' + uuid();
            const stub = await startAwsSsm({ accessKeyId, path: '/starter-crm', secrets });
            return {
                stub,
                env: {
                    DC_SECRETS: 'aws-ssm', DC_AWS_SSM_PATH: '/starter-crm', AWS_REGION: 'us-east-1',
                    AWS_ACCESS_KEY_ID: accessKeyId, AWS_SECRET_ACCESS_KEY: secretAccessKey, AWS_ENDPOINT_URL_SSM: stub.url
                },
                secretsOf: [secretAccessKey]
            };
        },
        label: 'AWS Parameter Store'
    }
];

for (const provider of PROVIDERS) {
    describe('secrets provider: ' + provider.name, () => {
        it('loads the API key, API secret and webhook secret from the manager, and ignores the rest', async () => {
            const webhook = 'managed-webhook-' + uuid();
            const secrets = managedSecrets(webhook);
            const { stub, env, secretsOf } = await provider.start(secrets);
            const name = 'managed-' + provider.name.replace(/\W+/g, '-');
            const server = await bootServer(name, envWithoutSecrets(env));
            try {
                await resetMock();
                const minted = await postJson(name, '/api/dropcowboy/token', { purpose: 'session' });
                assert.equal(minted.status, 200, JSON.stringify(minted.body));
                const upstream = (await mockRequests()).find((r) => r.path.includes('token'));
                assert.equal(upstream.headers['x-key'], ctx.secrets.apiKey, 'the API key came from the manager');
                assert.equal((await deliver(name, eventBody(uuid()), { secret: webhook })).status, 200, 'the webhook secret came from the manager');
                assertEnvelope(await deliver(name, eventBody(uuid()), { secret: secrets.UNRELATED_SECRET }), 401, 'invalid_signature');
                for (const value of [...Object.values(secrets), ...secretsOf]) {
                    assert.ok(!server.output().includes(value), 'a secret or credential was printed');
                }
            } finally {
                await server.stop();
                await stub.close();
            }
        });

        it('uses a rotated value without a restart, and keeps the last good values while the manager is down', async () => {
            const first = 'rotating-one-' + uuid();
            const second = 'rotating-two-' + uuid();
            const { stub, env, secretsOf } = await provider.start(managedSecrets(first));
            const name = 'rotating-' + provider.name.replace(/\W+/g, '-');
            const server = await bootServer(name, envWithoutSecrets(env));
            const delivery = (secret) => deliver(name, eventBody(uuid()), { secret });
            try {
                assert.equal((await delivery(first)).status, 200);
                assertEnvelope(await delivery(second), 401, 'invalid_signature');

                stub.secrets.DROPCOWBOY_WEBHOOK_SECRET = second;
                stub.version = 2;
                await sleep(2600);
                assert.equal((await delivery(second)).status, 200, 'the new value is in use without a restart');
                assertEnvelope(await delivery(first), 401, 'invalid_signature');

                stub.fail(503);
                await sleep(2600);
                assert.equal((await delivery(second)).status, 200, 'an outage keeps the last good value');
                // The output of a server in a container arrives a few milliseconds late.
                for (let i = 0; i < 20 && !/refresh/i.test(server.output()); i++) await sleep(100);
                assert.match(server.output(), /refresh/i, 'the failure is logged');
                assert.match(server.output(), new RegExp(provider.label + ' answered HTTP 503'), 'the log says what the manager answered');
                for (const value of [first, second, ...secretsOf]) {
                    assert.ok(!server.output().includes(value), 'a secret or credential was printed');
                }

                stub.fail(null);
                stub.secrets.DROPCOWBOY_WEBHOOK_SECRET = first;
                await sleep(2600);
                assert.equal((await delivery(first)).status, 200, 'it recovers when the manager is back');
            } finally {
                await server.stop();
                await stub.close();
            }
        });

        it('a wrong credential stops the boot with secret_load_failed, and prints neither credential', async () => {
            const { stub, env, secretsOf } = await provider.start(managedSecrets('x-' + uuid()));
            const wrong = 'wrong-credential-' + uuid();
            try {
                const output = await bootFails(envWithoutSecrets({ ...env, [provider.credential]: wrong }));
                assert.match(output, /secret_load_failed/);
                assert.match(output, new RegExp(provider.label));
                assert.match(output, /HTTP (400|401|403)/);
                for (const value of [wrong, ...secretsOf]) assert.ok(!output.includes(value), 'a credential was printed');
            } finally {
                await stub.close();
            }
        });

        it('an unreachable manager stops the boot and says so', async () => {
            const { stub, env } = await provider.start(managedSecrets('x-' + uuid()));
            await stub.close();
            const output = await bootFails(envWithoutSecrets(env));
            assert.match(output, /secret_load_failed/);
            assert.match(output, /could not be reached/);
        });
    });
}

describe('secrets provider settings', () => {
    const cases = [
        ['missing_doppler_token', { DC_SECRETS: 'doppler' }],
        ['invalid_secrets_url', { DC_SECRETS: 'doppler', DOPPLER_TOKEN: 'dp.st.x', DOPPLER_API_URL: 'http://secrets.example.com' }],
        ['invalid_secrets_url', { DC_SECRETS: 'doppler', DOPPLER_TOKEN: 'dp.st.x', DOPPLER_API_URL: 'not a url' }],
        ['missing_infisical_setting', { DC_SECRETS: 'infisical' }],
        ['invalid_secrets_url', { DC_SECRETS: 'infisical', INFISICAL_CLIENT_ID: 'a', INFISICAL_CLIENT_SECRET: 'b', INFISICAL_PROJECT_ID: 'c', INFISICAL_URL: 'http://infisical.example.com' }],
        ['missing_vault_setting', { DC_SECRETS: 'vault' }],
        ['missing_vault_setting', { DC_SECRETS: 'vault', VAULT_ADDR: 'https://vault.example.com', VAULT_PATH: 'p', VAULT_ROLE_ID: 'r' }],
        ['invalid_vault_auth', { DC_SECRETS: 'vault', VAULT_ADDR: 'https://vault.example.com', VAULT_PATH: 'p', VAULT_TOKEN: 't', VAULT_ROLE_ID: 'r', VAULT_SECRET_ID: 's' }],
        ['invalid_secrets_url', { DC_SECRETS: 'vault', VAULT_ADDR: 'http://vault.example.com:8200', VAULT_PATH: 'p', VAULT_TOKEN: 't' }],
        ['invalid_vault_path', { DC_SECRETS: 'vault', VAULT_ADDR: 'https://vault.example.com', VAULT_PATH: 'a/../b', VAULT_TOKEN: 't' }],
        ['missing_aws_secret_id', { DC_SECRETS: 'aws-secrets-manager', AWS_REGION: 'us-east-1' }],
        ['missing_aws_region', { DC_SECRETS: 'aws-secrets-manager', DC_AWS_SECRET_ID: 'starter-crm/prod', AWS_REGION: '', AWS_DEFAULT_REGION: '' }],
        ['missing_aws_ssm_path', { DC_SECRETS: 'aws-ssm', AWS_REGION: 'us-east-1' }],
        ['invalid_aws_ssm_path', { DC_SECRETS: 'aws-ssm', DC_AWS_SSM_PATH: 'no-leading-slash', AWS_REGION: 'us-east-1' }],
        ['invalid_aws_endpoint', { DC_SECRETS: 'aws-ssm', DC_AWS_SSM_PATH: '/starter-crm', AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL: 'not a url' }],
        ['insecure_aws_endpoint', { DC_SECRETS: 'aws-ssm', DC_AWS_SSM_PATH: '/starter-crm', AWS_REGION: 'us-east-1', AWS_ENDPOINT_URL: 'http://ssm.example.com', DC_ENV: 'production' }],
        ['missing_onepassword_setting', { DC_SECRETS: '1password' }],
        ['invalid_onepassword_setting', { DC_SECRETS: '1password', OP_SERVICE_ACCOUNT_TOKEN: 't', OP_VAULT: 'a/b' }]
    ];
    for (const [code, env] of cases) {
        it(code + ': ' + env.DC_SECRETS + (env.VAULT_ADDR || env.DOPPLER_API_URL || env.INFISICAL_URL || env.AWS_ENDPOINT_URL || env.DC_AWS_SSM_PATH || ''), async () => {
            const output = await bootFails({ ...serverEnv(), ...env });
            assert.match(output, new RegExp(code), 'output should name ' + code + ':\n' + output);
        });
    }

    it('refuses a redirect, so a credential is never forwarded to another host', async () => {
        let followed = 0;
        const target = http.createServer((req, res) => { followed += 1; res.end('{}'); });
        await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
        const redirector = http.createServer((req, res) => {
            res.writeHead(302, { location: 'http://127.0.0.1:' + target.address().port + '/stolen' });
            res.end();
        });
        await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
        const token = 'dp.st.' + uuid();
        try {
            const output = await bootFails({ ...serverEnv(), DC_SECRETS: 'doppler', DOPPLER_TOKEN: token, DOPPLER_API_URL: 'http://127.0.0.1:' + redirector.address().port });
            assert.match(output, /secret_load_failed/);
            assert.match(output, /redirect/i);
            assert.equal(followed, 0, 'the redirect target must not be called');
            assert.ok(!output.includes(token), 'the token was printed');
        } finally {
            redirector.closeAllConnections();
            target.closeAllConnections();
            await new Promise((resolve) => redirector.close(resolve));
            await new Promise((resolve) => target.close(resolve));
        }
    });
});

describe('secrets provider sign-in handling', () => {
    it('infisical: signs in again when an access token is revoked before it expires', async () => {
        const webhook = 'managed-webhook-' + uuid();
        const { stub, env } = await PROVIDERS[1].start(managedSecrets(webhook));
        const server = await bootServer('infisical-revoked', envWithoutSecrets(env));
        try {
            assert.equal(stub.logins, 1, 'one sign-in at boot');
            stub.revokeTokens();
            await sleep(2600);
            assert.equal((await deliver('infisical-revoked', eventBody(uuid()), { secret: webhook })).status, 200);
            assert.equal(stub.logins, 2, 'a 401 caused exactly one new sign-in');
        } finally {
            await server.stop();
            await stub.close();
        }
    });

    it('infisical: signs in again once the access token has expired', async () => {
        // A token that lives 30 seconds is already inside the provider's safety margin, so every refresh signs in.
        const { stub, env } = await PROVIDERS[1].start(managedSecrets('x-' + uuid()), { expiresIn: 30 });
        const server = await bootServer('infisical-expiring', envWithoutSecrets(env));
        try {
            await sleep(2600);
            await call('infisical-expiring');
            assert.ok(stub.logins >= 2, 'expected another sign-in, saw ' + stub.logins);
        } finally {
            await server.stop();
            await stub.close();
        }
    });

    it('vault AppRole: logs in again when the token is revoked early', async () => {
        const webhook = 'managed-webhook-' + uuid();
        const { stub, env } = await PROVIDERS[3].start(managedSecrets(webhook));
        const server = await bootServer('vault-revoked', envWithoutSecrets(env));
        try {
            assert.equal(stub.logins, 1);
            stub.revokeTokens();
            await sleep(2600);
            assert.equal((await deliver('vault-revoked', eventBody(uuid()), { secret: webhook })).status, 200);
            assert.equal(stub.logins, 2, 'a 403 caused exactly one new login');
        } finally {
            await server.stop();
            await stub.close();
        }
    });

    it('vault: names the mount and path when the secret does not exist', async () => {
        const token = 'hvs.' + uuid();
        const stub = await startVault({ token, path: 'starter-crm', secrets: {} });
        try {
            const output = await bootFails(envWithoutSecrets({ DC_SECRETS: 'vault', VAULT_ADDR: stub.url, VAULT_TOKEN: token, VAULT_PATH: 'typo-crm' }));
            assert.match(output, /secret_load_failed/);
            assert.match(output, /secret\/typo-crm/);
            assert.ok(!output.includes(token));
        } finally {
            await stub.close();
        }
    });

    it('vault: sends the namespace header', async () => {
        const token = 'hvs.' + uuid();
        const stub = await startVault({ token, path: 'starter-crm', secrets: managedSecrets('x-' + uuid()), namespace: 'team-a' });
        const server = await bootServer('vault-namespace', envWithoutSecrets({ DC_SECRETS: 'vault', VAULT_ADDR: stub.url, VAULT_TOKEN: token, VAULT_PATH: 'starter-crm', VAULT_NAMESPACE: 'team-a' }));
        try {
            assert.ok(stub.requests.some((r) => r.headers['x-vault-namespace'] === 'team-a'));
        } finally {
            await server.stop();
            await stub.close();
        }
    });
});

async function call(name) {
    return (await fetch(ctx.servers[name].url + '/healthz')).status;
}
