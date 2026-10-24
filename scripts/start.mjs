#!/usr/bin/env node
/**
 * `npm start` — run the Node Starter CRM server from the starter root.
 *
 * Where it sits: starter root. If `.env` is missing, prints how to run setup.
 * Passes through to `server/node` (`node src/index.js`) and forwards SIGTERM /
 * SIGINT so graceful drain still works when started from the root script.
 *
 * Plan section 8.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

if (!fs.existsSync(envPath)) {
    console.error('No .env at the starter root. Run: npm run setup');
    process.exit(1);
}

const child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(root, 'server/node'),
    stdio: 'inherit',
    env: process.env
});

function forward(signal) {
    try {
        child.kill(signal);
    } catch {
        // Child already gone.
    }
}
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));

child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
});
