// Static checks that nothing private ships with this starter: credentials,
// real tokens, internal hostnames, ID formats this starter must not teach, or
// Building Blocks code, which is closed source.
//
//   node --test tests/leak-check.test.js      (from the starter root)
//
// Each check reads every text file in the starter except installed
// dependencies, build output, test output, the browser tests' download cache
// and your local .env files.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set([
    'node_modules', '.venv', 'venv', 'dist', 'coverage', 'test-results', 'playwright-report',
    '__pycache__', '.pytest_cache', '.ruff_cache', '.git', '.dropcowboy', '.cdn-cache'
]);
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|eot|zip|gz|pdf|mp3|wav)$/i;

const files = listFiles(ROOT);

describe('leak checks', () => {
    it('scans the starter', () => {
        assert.ok(files.length > 50, 'expected to find the starter\'s files, found ' + files.length);
    });

    it('ships no Building Blocks code', () => {
        // Building Blocks are closed source. The browser tests download the
        // pinned release at test time into tests/e2e/.cdn-cache, which git ignores.
        const found = files
            .filter((f) => path.basename(f.path) === 'building-blocks-manifest.json'
                || /^\/\*!\s*Drop Cowboy Building Blocks/.test(f.lines[0] || ''))
            .map((f) => f.path);
        assert.deepEqual(found, []);
    });

    it('has no private keys', () => {
        expectNone(files, /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/);
    });

    it('has no cloud or service credentials', () => {
        expectNone(files, new RegExp([
            'AKIA[0-9A-Z]{16}',              // AWS access key id
            'gh[pousr]_[A-Za-z0-9]{36}',     // GitHub tokens
            'github_pat_[A-Za-z0-9_]{40,}',
            'xox[abprs]-[A-Za-z0-9-]{10,}',  // Slack
            'sk_live_[A-Za-z0-9]{16,}',      // Stripe
            'AIza[0-9A-Za-z_-]{35}',         // Google API key
            'npm_[A-Za-z0-9]{36}'
        ].join('|')));
    });

    it('has no credentials filled in .env.example', () => {
        const example = files.find((f) => f.path === '.env.example');
        assert.ok(example, '.env.example is missing');
        const filled = [];
        for (const [i, line] of example.lines.entries()) {
            const m = line.match(/^\s*([A-Z0-9_]*(?:KEY|SECRET|PASSWORD|TOKEN|CLIENT_ID|SITE_ID))\s*=\s*(.*)$/);
            if (m && m[2].trim() !== '') {
                filled.push('.env.example:' + (i + 1) + ' ' + m[1] + ' has a value');
            }
        }
        assert.deepEqual(filled, []);
    });

    it('has no real-looking JWTs', () => {
        // Tests and docs use JWT-shaped placeholders. A real JWT's signature
        // is random bytes; a placeholder's decodes to readable text, such as
        // "signature". Anything else is treated as a real token.
        const found = [];
        for (const file of files) {
            for (const [i, line] of file.lines.entries()) {
                for (const m of line.matchAll(/eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{2,}\.([A-Za-z0-9_-]+)/g)) {
                    if (!/^[a-z -]+$/i.test(Buffer.from(m[1], 'base64url').toString('latin1'))) {
                        found.push(file.path + ':' + (i + 1));
                    }
                }
            }
        }
        assert.deepEqual(found, [], 'JWT-shaped strings with a real-looking signature');
    });

    it('uses plain UUIDs, never type-prefixed ids', () => {
        // A quoted word, an underscore, then a run of letters and digits: the
        // shape of Stripe-style ids. snake_case names have no digits, so they pass.
        expectNone(files, /["'`][a-z]{2,10}_(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{6,}["'`]/);
    });

    it('never names the backend vendor', () => {
        // Spelled in two halves so this file does not match itself.
        expectNone(files, new RegExp('coms' + 'api', 'i'));
    });

    it('names only public Drop Cowboy hosts', () => {
        const PUBLIC = new Set(['www', 'api-v2', 'app-api-v2', 'webforms', 'login', 'mcp', 'docs', 'detect']);
        const found = [];
        for (const file of files) {
            for (const [i, line] of file.lines.entries()) {
                for (const m of line.matchAll(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)*)\.dropcowboy\.(?:com|io|net|dev|internal)\b/gi)) {
                    if (!PUBLIC.has(m[1].toLowerCase())) {
                        found.push(file.path + ':' + (i + 1) + ' ' + m[0]);
                    }
                }
            }
        }
        assert.deepEqual(found, []);
    });

    it('names no cloud-internal hosts or private addresses', () => {
        // The dev-session tests use these two to show non-loopback callers are refused.
        const EXAMPLES = new Set(['10.0.0.5', '192.168.1.20']);
        const found = [];
        const pattern = /\b[a-z0-9.-]+\.(?:amazonaws\.com|internal|corp|lan)\b|\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))(?:\.\d{1,3}){2,3}\b/gi;
        for (const file of files) {
            for (const [i, line] of file.lines.entries()) {
                for (const m of line.matchAll(pattern)) {
                    if (!EXAMPLES.has(m[0]) && isFullAddressOrHost(m[0])) {
                        found.push(file.path + ':' + (i + 1) + ' ' + m[0]);
                    }
                }
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
        // gitleaks does not read .gitignore, so scan a copy of the same files the
        // checks above read. Otherwise your filled-in .env fails the suite.
        const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-crm-leaks-'));
        try {
            for (const file of files) {
                const target = path.join(copy, file.path);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.writeFileSync(target, file.lines.join('\n'));
            }
            const run = spawnSync('gitleaks', [
                'dir', copy, '--config', path.join(ROOT, '.gitleaks.toml'), '--no-banner', '--redact', '--exit-code', '1'
            ], { encoding: 'utf8' });
            assert.equal(run.status, 0, 'gitleaks found something:\n' + run.stdout + run.stderr);
        } finally {
            fs.rmSync(copy, { recursive: true, force: true });
        }
    });
});

function listFiles(root) {
    const out = [];
    const visit = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) visit(full);
                continue;
            }
            // Local .env files hold your own credentials and are never committed.
            if (/^\.env(\..+)?$/.test(entry.name) && entry.name !== '.env.example') continue;
            if (BINARY.test(entry.name)) continue;
            const text = fs.readFileSync(full, 'utf8');
            out.push({ path: path.relative(root, full), lines: text.split('\n') });
        }
    };
    visit(root);
    return out;
}

function expectNone(fileList, pattern) {
    const found = [];
    for (const file of fileList) {
        for (const [i, line] of file.lines.entries()) {
            if (pattern.test(line)) {
                found.push(file.path + ':' + (i + 1) + '  ' + line.trim().slice(0, 120));
            }
        }
    }
    assert.deepEqual(found, []);
}

// "10.4.2" is a version number, not an address: an IPv4 address has four parts.
function isFullAddressOrHost(match) {
    return /[a-z]/i.test(match) || match.split('.').length === 4;
}
