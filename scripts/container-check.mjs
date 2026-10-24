#!/usr/bin/env node
// Builds one container image and runs everything that proves it, in order:
//
//   node scripts/container-check.mjs node       # the Node server image (Dockerfile)
//   node scripts/container-check.mjs python     # the Python server image (server/python/Dockerfile)
//   node scripts/container-check.mjs node --keep   # leave the image in Docker afterwards
//
// Where it sits: `npm test` runs it as the stages container:node and
// container:python. The steps are
//   1. docker build the image from the starter root,
//   2. the conformance suite against a container of it (the same cases that
//      prove the servers run from source; see scripts/lib/container-server.sh),
//   3. the smoke checks (non-root, healthy, read-only filesystem, SIGTERM),
//   4. the leak checks on what the image contains.
// It needs Docker and nothing else. The last lines are in the format the
// test runner reads (`ℹ pass N`, `ℹ fail N`), summed over all the steps.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const which = process.argv[2];
const keep = process.argv.includes('--keep');

const IMAGES = {
    node: { tag: 'starter-crm-check-node', dockerfile: 'Dockerfile', lang: 'node' },
    python: { tag: 'starter-crm-check-python', dockerfile: path.join('server', 'python', 'Dockerfile'), lang: 'python' }
};
const image = IMAGES[which];
if (!image) {
    console.error('Usage: node scripts/container-check.mjs <node|python> [--keep]');
    process.exit(2);
}

const steps = [
    { name: 'build', command: ['docker', 'build', '--tag', image.tag, '--file', image.dockerfile, '.'], cwd: ROOT, counts: false },
    {
        name: 'conformance',
        command: ['node', 'run.js'],
        cwd: path.join(ROOT, 'server', 'conformance'),
        env: {
            SERVER_CMD: 'bash ' + path.join(ROOT, 'scripts', 'lib', 'container-server.sh') + ' ' + image.tag,
            SERVER_CWD: ROOT,
            SERVER_LANG: image.lang
        }
    },
    { name: 'smoke', command: ['node', '--test', '--test-reporter=spec', 'tests/container-smoke.test.js'], cwd: ROOT, env: { IMAGE: image.tag } },
    { name: 'image leaks', command: ['node', '--test', '--test-reporter=spec', 'tests/image-leak-check.test.js'], cwd: ROOT, env: { IMAGE: image.tag } }
];

let passed = 0;
let failed = 0;
let skipped = 0;
let broken = null;
for (const step of steps) {
    console.log('\n--- ' + image.tag + ': ' + step.name + ' ---');
    const { code, output } = await run(step);
    if (step.counts !== false) {
        const plain = output.replace(/\x1b\[[0-9;]*m/g, ''); // eslint-disable-line no-control-regex -- strips ANSI colour codes
        passed += last(plain, /ℹ pass (\d+)/g);
        failed += last(plain, /ℹ fail (\d+)/g);
        skipped += last(plain, /ℹ skipped (\d+)/g);
    }
    if (code !== 0) {
        broken = step.name;
        break;
    }
}
if (!keep) await run({ command: ['docker', 'rmi', '--force', image.tag], cwd: ROOT, quiet: true });

console.log('\nℹ pass ' + passed + '\nℹ fail ' + failed + '\nℹ skipped ' + skipped);
if (broken) console.error('Stopped at the "' + broken + '" step.');
process.exit(broken ? 1 : 0);

function last(text, pattern) {
    const all = [...text.matchAll(pattern)];
    return all.length ? Number(all[all.length - 1][1]) : 0;
}

function run({ command, cwd, env, quiet }) {
    return new Promise((resolve) => {
        const child = spawn(command[0], command.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const relay = (stream) => (chunk) => {
            output += chunk;
            if (!quiet) stream.write(chunk);
        };
        child.stdout.on('data', relay(process.stdout));
        child.stderr.on('data', relay(process.stderr));
        child.on('error', (err) => resolve({ code: 1, output: output + String(err) }));
        child.on('close', (code) => resolve({ code: code === null ? 1 : code, output }));
    });
}
