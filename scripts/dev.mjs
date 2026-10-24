#!/usr/bin/env node
/**
 * `npm run dev` — Node server with --watch from the starter root.
 *
 * Plan section 8. For the React front-end, run `npm run dev` in react/ too.
 * Forwards SIGTERM / SIGINT to the child so drain still works.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(path.join(root, '.env'))) {
    console.error('No .env at the starter root. Run: npm run setup');
    process.exit(1);
}

const child = spawn(process.execPath, ['--watch', 'src/index.js'], {
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
