import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { BUILTINS, KIND_VARIABLES, resolveProvider, shapeProblem } from '../src/providers/index.js';
import * as oidc from '../src/providers/identity/oidc.js';
import * as passcode from '../src/providers/identity/passcode.js';
import * as fileSecrets from '../src/providers/secrets/file.js';
import { checkProvider } from '../../conformance/provider/check.js';
import { SITE_ID, makeConfig } from './helpers.js';

const dirs = [];
function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-crm-providers-'));
    dirs.push(dir);
    return dir;
}
afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('shapeProblem', () => {
    it('accepts a complete module and names the first missing export', () => {
        const good = { name: 'x', configKeys: [], validate() {}, create() {} };
        expect(shapeProblem(good)).toBeNull();
        expect(shapeProblem({ ...good, name: undefined })).toContain('name');
        expect(shapeProblem({ ...good, configKeys: undefined })).toContain('configKeys');
        expect(shapeProblem({ ...good, validate: undefined })).toContain('validate');
        expect(shapeProblem({ ...good, create: undefined })).toContain('create');
        expect(shapeProblem(null)).toContain('nothing');
    });
});

describe('resolveProvider', () => {
    it('returns the built-in module for a name', async () => {
        const { module, problem } = await resolveProvider('ratelimit', 'memory', '/x');
        expect(problem).toBeNull();
        expect(module.name).toBe('memory');
    });

    it('returns no module for none', async () => {
        expect(await resolveProvider('observer', null, '/x')).toEqual({ module: null, problem: null });
    });

    it('names the variable and the choices for an unknown built-in', async () => {
        const { problem } = await resolveProvider('secrets', 'nonexistent', '/x');
        expect(problem.code).toBe('unknown_provider');
        expect(problem.message).toContain('DC_SECRETS=nonexistent');
        expect(problem.fix).toContain('env, file');
    });

    it('does not treat an inherited property name as a built-in', async () => {
        const { problem } = await resolveProvider('identity', 'constructor', '/x');
        expect(problem.code).toBe('unknown_provider');
    });

    it('loads a provider from a relative path and rejects a missing or malformed one', async () => {
        const root = tempDir();
        fs.writeFileSync(path.join(root, 'good.js'), "export const name = 'mine'; export const configKeys = []; export const validate = () => []; export const create = () => ({ hit: async () => ({ allowed: true, remaining: 1, retryAfterSeconds: 1 }) });\n");
        fs.writeFileSync(path.join(root, 'bad.js'), "export const name = 'mine';\n");
        expect((await resolveProvider('ratelimit', './good.js', root)).module.name).toBe('mine');
        expect((await resolveProvider('ratelimit', './missing.js', root)).problem.code).toBe('invalid_provider');
        const bad = await resolveProvider('ratelimit', './bad.js', root);
        expect(bad.problem.code).toBe('invalid_provider');
        expect(bad.problem.message).toContain('configKeys');
    });

    it('has a variable for every kind and a built-in table for every kind', () => {
        expect(Object.keys(KIND_VARIABLES).sort()).toEqual(Object.keys(BUILTINS).sort());
    });
});

describe('passcode validate', () => {
    it('requires a passcode of at least 12 characters and never echoes it', () => {
        expect(passcode.validate({}).map((p) => p.code)).toEqual(['missing_passcode']);
        const weak = passcode.validate({ DC_PASSCODE: 'short-pass' });
        expect(weak.map((p) => p.code)).toEqual(['weak_passcode']);
        expect(JSON.stringify(weak)).not.toContain('short-pass');
        expect(passcode.validate({ DC_PASSCODE: 'a-long-enough-passcode' })).toEqual([]);
    });
});

describe('oidc validate', () => {
    it('requires issuer and audience, an https issuer (http only on loopback) and an http(s) JWKS URL', () => {
        const codes = (env) => oidc.validate(env).map((p) => p.code);
        expect(codes({})).toEqual(['missing_oidc_issuer', 'missing_oidc_audience']);
        expect(codes({ DC_OIDC_ISSUER: 'http://issuer.example.com', DC_OIDC_AUDIENCE: 'a' })).toEqual(['invalid_oidc_issuer']);
        expect(codes({ DC_OIDC_ISSUER: 'http://localhost:9000', DC_OIDC_AUDIENCE: 'a' })).toEqual([]);
        expect(codes({ DC_OIDC_ISSUER: 'https://issuer.example.com', DC_OIDC_AUDIENCE: 'a', DC_OIDC_JWKS_URL: 'ftp://x' })).toEqual(['invalid_oidc_jwks_url']);
    });
});

describe('file secrets', () => {
    it('reads one file per name, trims whitespace and skips names it does not have', async () => {
        const dir = tempDir();
        fs.writeFileSync(path.join(dir, 'DROPCOWBOY_API_KEY'), ' file-key-1234 \n');
        const logged = [];
        const instance = fileSecrets.create({ env: { DC_SECRETS_DIR: dir }, config: makeConfig(), log: { warn: async (t) => logged.push(t) } });
        expect(await instance.load(['DROPCOWBOY_API_KEY', 'NOT_THERE'])).toEqual({ DROPCOWBOY_API_KEY: 'file-key-1234' });
    });

    it('refuses a name that could escape the folder', async () => {
        const dir = tempDir();
        const instance = fileSecrets.create({ env: { DC_SECRETS_DIR: dir }, config: makeConfig(), log: { warn: async () => {} } });
        expect(await instance.load(['../etc/passwd'])).toEqual({});
    });

    it('requires an existing directory', () => {
        expect(fileSecrets.validate({}).map((p) => p.code)).toEqual(['missing_secrets_dir']);
        expect(fileSecrets.validate({ DC_SECRETS_DIR: '/definitely/not/here' }).map((p) => p.code)).toEqual(['missing_secrets_dir']);
    });
});

describe('provider conformance check (Node)', () => {
    const root = path.resolve(import.meta.dirname, '..', '..', '..');
    const builtins = [
        ['identity', 'identity/dev.js', {}],
        ['identity', 'identity/passcode.js', { DC_PASSCODE: 'a-long-enough-passcode' }],
        ['secrets', 'secrets/env.js', {}],
        ['ratelimit', 'ratelimit/memory.js', {}],
        ['ratelimit', 'ratelimit/off.js', {}],
        ['log', 'log/console.js', {}]
    ];
    for (const [kind, file, env] of builtins) {
        it('passes for the built-in ' + file, async () => {
            const results = await checkProvider(kind, path.join(import.meta.dirname, '..', 'src', 'providers', file), { env, loadConfig, root });
            const failed = results.filter((r) => !r.ok);
            expect(failed).toEqual([]);
            expect(results.length).toBeGreaterThanOrEqual(5);
        });
    }

    it('passes for the built-in file secrets provider', async () => {
        const dir = tempDir();
        const results = await checkProvider('secrets', path.join(import.meta.dirname, '..', 'src', 'providers', 'secrets', 'file.js'),
            { env: { DC_SECRETS_DIR: dir }, loadConfig, root });
        expect(results.filter((r) => !r.ok)).toEqual([]);
    });

    it('fails a provider that is the wrong shape, and one whose limiter never refuses', async () => {
        const dir = tempDir();
        const shape = path.join(dir, 'shape.js');
        fs.writeFileSync(shape, "export const name = 'x';\n");
        const bad = await checkProvider('ratelimit', shape, { loadConfig, root });
        expect(bad.some((r) => !r.ok && r.name.includes('exports name'))).toBe(true);

        const lax = path.join(dir, 'lax.js');
        fs.writeFileSync(lax, "export const name = 'lax'; export const configKeys = []; export const validate = () => []; export const create = () => ({ hit: async () => ({ allowed: true, remaining: 9, retryAfterSeconds: 1 }) });\n");
        const result = await checkProvider('ratelimit', lax, { loadConfig, root });
        expect(result.some((r) => !r.ok && r.name.startsWith('hit()'))).toBe(true);
    });

    it('applies an identity provider test vector', async () => {
        const dir = tempDir();
        const file = path.join(dir, 'header-identity.js');
        fs.writeFileSync(file, `export const name = 'header'; export const configKeys = []; export const validate = () => [];
export const create = () => ({ authenticate: async (request) => { const id = request.headers.get('x-user'); return id ? { id } : null; } });
export const testVectors = [{ name: 'a header', headers: { 'x-user': '${SITE_ID}' }, expect: { id: '${SITE_ID}' } }, { name: 'none', headers: {}, expect: null }];
`);
        const results = await checkProvider('identity', file, { loadConfig, root });
        expect(results.filter((r) => !r.ok)).toEqual([]);
        expect(results.some((r) => r.name === 'testVectors: a header')).toBe(true);
    });

    it('resolves a bare built-in name through the registry, as the command line does', async () => {
        // Protects the docs' `conformance:provider -- identity oidc ...` form: a name with no
        // path separator or extension is a built-in, never a file next to the current directory.
        const results = await checkProvider('ratelimit', 'memory', { loadConfig, root, builtins: BUILTINS });
        expect(results.filter((r) => !r.ok)).toEqual([]);
        expect(results.length).toBeGreaterThanOrEqual(5);
    });

    it('treats a name that is not a built-in as a file', async () => {
        const results = await checkProvider('ratelimit', 'nonexistent', { loadConfig, root, builtins: BUILTINS });
        expect(results[0]).toMatchObject({ name: 'the file loads', ok: false });
    });

    it('rejects an unknown kind', async () => {
        const results = await checkProvider('nonsense', 'x.js', { loadConfig, root });
        expect(results[0].ok).toBe(false);
    });
});
