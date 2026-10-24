// The leak checks, run on what an image actually contains instead of on the
// source tree: no credentials, no private keys, no internal hosts, no Building
// Blocks (closed source), no git history, no tests, no .env files.
//
//   IMAGE=starter-crm:test node --test tests/image-leak-check.test.js
//
// Where it sits: the source-tree checks in tests/leak-check.test.js cannot see
// a stray COPY line or a missing .dockerignore entry, and those are how a
// secret reaches a registry. This copies /app out of the image and reads every
// text file in it except installed dependencies, which are third-party code.
// `npm test` runs it once per image (stages container:node, container:python).

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const image = process.env.IMAGE;
if (!image) throw new Error('Set IMAGE to the image to check, for example IMAGE=starter-crm:test');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'site-packages', '__pycache__']);
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|zip|gz|pdf|mp3|wav|pyc)$/i;

let copy;
let files = [];

before(() => {
    copy = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-crm-image-'));
    const name = 'starter-crm-leaks-' + crypto.randomUUID();
    docker(['create', '--name', name, image]);
    try {
        docker(['cp', name + ':/app/.', copy]);
    } finally {
        spawnSync('docker', ['rm', '--force', name]);
    }
    files = listFiles(copy);
});

after(() => fs.rmSync(copy, { recursive: true, force: true }));

describe('image leak checks for ' + image, () => {
    it('has the app in it', () => {
        assert.ok(files.length > 20, 'expected the app\'s files in /app, found ' + files.length);
    });

    it('ships no .env, .git, tests or browser-test download cache', () => {
        const found = files.map((f) => f.path).filter((p) => /(^|\/)\.env(\..+)?$|(^|\/)\.git(\/|$)|\.cdn-cache|\.test\.jsx?$|(^|\/)tests?\//.test(p));
        assert.deepEqual(found, []);
    });

    it('ships no Building Blocks code', () => {
        const found = files
            .filter((f) => path.basename(f.path) === 'building-blocks-manifest.json' || /^\/\*!\s*Drop Cowboy Building Blocks/.test(f.lines[0] || ''))
            .map((f) => f.path);
        assert.deepEqual(found, []);
    });

    it('has no private keys or cloud and service credentials', () => {
        expectNone(files, new RegExp([
            '-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----',
            'AKIA[0-9A-Z]{16}',
            'gh[pousr]_[A-Za-z0-9]{36}',
            'github_pat_[A-Za-z0-9_]{40,}',
            'xox[abprs]-[A-Za-z0-9-]{10,}',
            'sk_live_[A-Za-z0-9]{16,}',
            'AIza[0-9A-Za-z_-]{35}',
            'npm_[A-Za-z0-9]{36}'
        ].join('|')));
    });

    it('names no internal hosts or private addresses', () => {
        // A host needs two labels before .internal, .corp or .lan: a minified bundle
        // contains property accesses such as "this" followed by "internal".
        const pattern = /\b[a-z0-9.-]+\.amazonaws\.com\b|\b[a-z0-9-]+\.[a-z0-9-]+\.(?:internal|corp|lan)\b|\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){3}\b/gi;
        const found = [];
        for (const file of files) {
            for (const [i, line] of file.lines.entries()) {
                for (const m of line.matchAll(pattern)) found.push(file.path + ':' + (i + 1) + ' ' + m[0]);
            }
        }
        assert.deepEqual(found, []);
    });

    it('passes gitleaks, when it is installed', (t) => {
        const probe = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
        if (probe.error) {
            t.skip('gitleaks is not installed (https://github.com/gitleaks/gitleaks); skipped');
            return;
        }
        const run = spawnSync('gitleaks', [
            'dir', copy, '--config', path.join(ROOT, '.gitleaks.toml'), '--no-banner', '--redact', '--exit-code', '1'
        ], { encoding: 'utf8' });
        assert.equal(run.status, 0, 'gitleaks found something:\n' + run.stdout + run.stderr);
    });
});

function docker(args) {
    const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) throw new Error('docker ' + args.join(' ') + ' failed:\n' + result.stdout + result.stderr);
    return result;
}

function listFiles(root) {
    const out = [];
    const visit = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) visit(full);
                continue;
            }
            if (!entry.isFile() || BINARY.test(entry.name)) continue;
            out.push({ path: path.relative(root, full), lines: fs.readFileSync(full, 'utf8').split('\n') });
        }
    };
    visit(root);
    return out;
}

function expectNone(list, pattern) {
    const found = [];
    for (const file of list) {
        for (const [i, line] of file.lines.entries()) {
            if (pattern.test(line)) found.push(file.path + ':' + (i + 1) + '  ' + line.trim().slice(0, 120));
        }
    }
    assert.deepEqual(found, []);
}
