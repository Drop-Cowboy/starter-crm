#!/usr/bin/env node
/**
 * `npm run setup` — first-run installer for the Starter CRM.
 *
 * Where it sits: starter root. Checks Node (>=24) and Python (>=3.11),
 * installs server deps, writes `.env` mode 0600 with a generated site id.
 *
 * Plan section 8. Customers run this once after cloning.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';
import { buildEnv, keptSettings, parseEnv } from './lib/env-file.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const yes = process.argv.includes('--yes');
const withPython = process.argv.includes('--python');

function run(command, args, opts = {}) {
    const result = spawnSync(command, args, { stdio: 'inherit', cwd: opts.cwd || root, env: process.env, shell: opts.shell });
    if (result.status !== 0) {
        throw new Error((command + ' ' + args.join(' ')).trim() + ' exited ' + result.status);
    }
}

function nodeMajor() {
    return Number(process.versions.node.split('.')[0]);
}

function findPython() {
    for (const candidate of [process.env.PYTHON, 'python3.11', 'python3.13', 'python3', 'python'].filter(Boolean)) {
        const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info >= (3, 11))'], { encoding: 'utf8' });
        if (probe.status === 0 && probe.stdout.trim() === 'True') return candidate;
    }
    return null;
}

async function ask(rl, question, { secret = false, defaultValue = '' } = {}) {
    if (yes) return defaultValue;
    if (!secret) {
        const answer = await rl.question(question + (defaultValue ? ' [' + defaultValue + ']' : '') + ': ');
        return answer.trim() || defaultValue;
    }
    // Muting the terminal is awkward cross-platform, so the value shows as it is
    // typed; say so, and that it is saved only in .env (mode 0600).
    const answer = await rl.question(question + ' (shown as you type, saved only in .env, mode 0600): ');
    return answer.trim();
}

async function main() {
    if (nodeMajor() < 24) {
        console.error('Node 24 or later is required (this shell has ' + process.version + ').');
        console.error('Install the current version from https://nodejs.org, open a new terminal, and run npm run setup again.');
        console.error('If you use nvm: nvm install 24 && nvm use 24');
        process.exit(1);
    }

    const rl = yes ? null : readline.createInterface({ input, output });
    try {
        console.log('Starter CRM setup');

        // Asked before anything else, so a "no" never throws away answers typed after it.
        const envPath = path.join(root, '.env');
        const existing = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : null;
        let replace = !existing;
        if (existing && yes) {
            console.log('.env already exists, so it was left as it is.');
        } else if (existing) {
            const answer = await ask(rl, '.env already exists. Replace it with new settings? (y/N)', { defaultValue: 'N' });
            replace = /^y/i.test(answer);
            if (!replace) console.log('Keeping your .env. To change one setting, edit .env and restart the server.');
        }

        if (replace) {
            console.log('Auth modes: server (default, production pattern), mcp-session (dev with MCP), login (coming soon).');
            const mode = (await ask(rl, 'DC_AUTH_MODE', { defaultValue: 'server' })) || 'server';
            const kept = keptSettings(existing);
            let siteId = '';
            let apiKey = '';
            let apiSecret = '';
            let userId = '8b6f4c2a-1d3e-4f5a-9b7c-0e2d4f6a8c1e';

            if (mode === 'server' || mode === 'login') {
                if (kept.siteId) {
                    siteId = kept.siteId;
                    console.log('Kept DROPCOWBOY_SITE_ID=' + siteId + ' from your old .env, so your inbox carries over.');
                } else {
                    siteId = crypto.randomUUID();
                    console.log('Generated DROPCOWBOY_SITE_ID=' + siteId);
                }
            }
            if (mode === 'server') {
                apiKey = await ask(rl, 'DROPCOWBOY_API_KEY', { secret: true, defaultValue: yes ? 'replace-me' : '' });
                apiSecret = await ask(rl, 'DROPCOWBOY_API_SECRET', { secret: true, defaultValue: yes ? 'replace-me' : '' });
                if (!yes) {
                    const customUser = await ask(rl, 'STARTER_CRM_USER_ID', { defaultValue: userId });
                    if (customUser) userId = customUser;
                }
            }
            writeEnv(envPath, { mode, siteId, apiKey, apiSecret, userId, webhookSecret: kept.webhookSecret });
        }

        console.log('Installing Node server dependencies…');
        run('npm', ['install'], { cwd: path.join(root, 'server/node') });

        const python = withPython || yes ? findPython() : null;
        if (withPython && !python) {
            console.error('Python 3.11+ not found. Install it or re-run without --python.');
            process.exit(1);
        }
        if (yes && !python) console.log('Python 3.11+ not found, so the Python server was not set up. The Node server does not need it.');
        if (python) {
            const venv = path.join(root, 'server/python/.venv');
            console.log('Creating Python virtualenv with ' + python + '…');
            run(python, ['-m', 'venv', '--clear', '.venv'], { cwd: path.join(root, 'server/python') });
            const pip = process.platform === 'win32'
                ? path.join(venv, 'Scripts', 'pip')
                : path.join(venv, 'bin', 'pip');
            run(pip, ['install', '-r', 'requirements.txt'], { cwd: path.join(root, 'server/python') });
        }

        console.log('Done. Next: npm start');
    } finally {
        if (rl) rl.close();
    }
}

function writeEnv(envPath, settings) {
    fs.writeFileSync(envPath, buildEnv(settings), { mode: 0o600 });
    try {
        fs.chmodSync(envPath, 0o600);
    } catch {
        // Windows.
    }
    console.log('Wrote ' + envPath + ' (mode 0600)');
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});
