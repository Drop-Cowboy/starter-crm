#!/usr/bin/env node
// Runs every test in the starter, in order, and prints a count per stage.
//
//   npm test                 everything
//   npm run test:fast        no browser and no Docker: unit tests, conformance, leak checks
//   npm run test:container   build both images and test the containers
//   node tests/run-all.mjs --only e2e:node:vanilla,leaks
//   node tests/run-all.mjs --list
//   node tests/run-all.mjs --install-only  install what the stages need, run nothing
//
// Missing npm dependencies are installed (npm ci) and a Python virtualenv is
// created in server/python/.venv the first time. Stages that need Python are
// skipped, with a notice, when no Python 3.11+ is found, and the container
// stages when Docker is not running. Set PYTHON to choose
// the interpreter.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...parts) => path.join(ROOT, ...parts);
const args = process.argv.slice(2);
const fast = args.includes('--fast');
const only = valueOf('--only');

const python = findPython();
const pythonServer = python && { SERVER_CMD: quote(python) + ' -m starter_crm', SERVER_CWD: at('server', 'python') };
// The Next.js variant (server/nextjs) runs the Node core behind Next route handlers; `npm start` there is its launcher.
const nextjsServer = { SERVER_CMD: 'exec node scripts/serve.mjs', SERVER_CWD: at('server', 'nextjs'), SERVER_LANG: 'node', NEXT_TELEMETRY_DISABLED: '1' };
// The Netlify variant (server/netlify) runs the same core in a Netlify function; its launcher runs that function locally.
const netlifyServer = { SERVER_CMD: 'exec node scripts/serve.mjs', SERVER_CWD: at('server', 'netlify'), SERVER_LANG: 'node' };
const noPython = python ? null : 'no Python 3.11+ found (set PYTHON to choose one)';
const noDocker = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0 ? null : 'Docker is not running (the container stages need it)';
const prepared = new Set();

/** @type {{ name: string, cwd: string, run: string[], env?: object, needs?: string[], skip?: string | null, browser?: boolean, build?: boolean, check?: boolean, container?: boolean }[]} */
const STAGES = [
    { name: 'scripts', cwd: ROOT, run: ['node', '--test', '--test-reporter=spec', 'scripts/new-module.test.mjs', 'scripts/deploy-aws.test.mjs', 'scripts/aws-template.test.mjs', 'scripts/env-file.test.mjs', 'scripts/webhook-check.test.mjs'] },
    { name: 'shared', cwd: at('shared'), run: ['npm', 'test'] },
    { name: 'server:node', cwd: at('server', 'node'), run: ['npm', 'test'], needs: ['server/node'] },
    { name: 'server:python', cwd: at('server', 'python'), run: [python, '-m', 'pytest', '-q'], skip: noPython, needs: ['python'] },
    { name: 'lint:node', cwd: at('server', 'node'), run: ['npm', 'run', 'lint'], needs: ['server/node'], check: true },
    { name: 'lint:python', cwd: at('server', 'python'), run: [python, '-m', 'ruff', 'check', '.'], skip: noPython, needs: ['python'], check: true },
    { name: 'format:python', cwd: at('server', 'python'), run: [python, '-m', 'ruff', 'format', '--check', '.'], skip: noPython, needs: ['python'], check: true },
    { name: 'conformance:node', cwd: at('server', 'conformance'), run: ['node', 'run.js'], needs: ['server/node'] },
    { name: 'conformance:python', cwd: at('server', 'conformance'), run: ['node', 'run.js'], env: pythonServer, skip: noPython, needs: ['python'] },
    { name: 'lint:nextjs', cwd: at('server', 'nextjs'), run: ['npm', 'run', 'lint'], needs: ['server/nextjs'], check: true },
    { name: 'react', cwd: at('react'), run: ['npm', 'test'], needs: ['react'] },
    { name: 'react:build', cwd: at('react'), run: ['npm', 'run', 'build'], needs: ['react'], browser: true, build: true },
    // `next build` of the variant (it builds the React app first), then the conformance suite against its launcher.
    { name: 'nextjs:build', cwd: at('server', 'nextjs'), run: ['npm', 'run', 'build'], env: { NEXT_TELEMETRY_DISABLED: '1' }, needs: ['server/nextjs', 'server/node', 'react'], build: true },
    { name: 'conformance:nextjs', cwd: at('server', 'conformance'), run: ['node', 'run.js'], env: nextjsServer, needs: ['server/node', 'server/nextjs'] },
    // The Netlify variant: its own tests, the CDN folder it builds, then the conformance suite against its function.
    { name: 'netlify', cwd: at('server', 'netlify'), run: ['npm', 'test'], needs: ['server/netlify', 'server/node'] },
    { name: 'lint:netlify', cwd: at('server', 'netlify'), run: ['npm', 'run', 'lint'], needs: ['server/netlify'], check: true },
    { name: 'netlify:build', cwd: at('server', 'netlify'), run: ['npm', 'run', 'build'], needs: ['server/netlify', 'server/node', 'react'], build: true },
    { name: 'conformance:netlify', cwd: at('server', 'conformance'), run: ['node', 'run.js'], env: netlifyServer, needs: ['server/node', 'server/netlify'] },
    ...['node', 'python'].flatMap((server) => ['vanilla', 'react'].map((ui) => ({
        name: 'e2e:' + server + ':' + ui,
        cwd: at('tests', 'e2e'),
        run: ['npx', 'playwright', 'test', '--project=' + ui],
        env: server === 'python' ? pythonServer : {},
        skip: server === 'python' ? noPython : null,
        needs: server === 'python' ? ['tests/e2e', 'python'] : ['tests/e2e', 'server/node'],
        browser: true
    }))),
    ...['vanilla', 'react'].map((ui) => ({
        name: 'e2e:nextjs:' + ui,
        cwd: at('tests', 'e2e'),
        run: ['npx', 'playwright', 'test', '--project=' + ui],
        env: nextjsServer,
        needs: ['tests/e2e', 'server/node', 'server/nextjs'],
        browser: true
    })),
    ...['vanilla', 'react'].map((ui) => ({
        name: 'e2e:netlify:' + ui,
        cwd: at('tests', 'e2e'),
        run: ['npx', 'playwright', 'test', '--project=' + ui],
        env: netlifyServer,
        needs: ['tests/e2e', 'server/node', 'server/netlify'],
        browser: true
    })),
    // Build each image, then run the conformance suite against a container of it,
    // the smoke checks and the leak checks on its contents. Slow, so not in --fast.
    ...['node', 'python'].map((server) => ({
        name: 'container:' + server,
        cwd: ROOT,
        run: ['node', 'scripts/container-check.mjs', server],
        skip: noDocker,
        container: true
    })),
    // compose.yaml itself: it builds and starts both servers with secrets from files.
    { name: 'container:compose', cwd: ROOT, run: ['node', '--test', '--test-reporter=spec', 'tests/compose-smoke.test.js'], skip: noDocker, container: true },
    { name: 'leaks', cwd: ROOT, run: ['node', '--test', '--test-reporter=spec', 'tests/leak-check.test.js'] }
];

if (args.includes('--list')) {
    console.log(STAGES.map((s) => s.name).join('\n'));
    process.exit(0);
}

if (args.includes('--install-only')) {
    const needs = [...new Set(STAGES.filter((s) => !s.skip).flatMap((s) => s.needs || []))];
    const error = await prepare(needs);
    if (noPython) console.log('Python was not set up: ' + noPython);
    if (error) {
        console.error(error);
        process.exit(1);
    }
    console.log('Installed: ' + needs.join(', '));
    process.exit(0);
}

const selected = STAGES.filter((stage) => (only ? only.split(',').includes(stage.name) : !(fast && (stage.browser || stage.container))));
if (only && selected.length === 0) {
    console.error('No stage matches --only ' + only + '. Stages:\n  ' + STAGES.map((s) => s.name).join('\n  '));
    process.exit(2);
}

const results = [];
for (const stage of selected) {
    if (stage.skip) {
        results.push({ name: stage.name, outcome: 'skipped', note: stage.skip });
        continue;
    }
    banner(stage.name);
    const setupError = await prepare(stage.needs || []);
    if (setupError) {
        results.push({ name: stage.name, outcome: 'failed', note: setupError });
        continue;
    }
    const started = Date.now();
    const { code, output } = await run(stage.run, stage.cwd, stage.env);
    results.push({
        name: stage.name,
        outcome: code === 0 ? 'passed' : 'failed',
        counts: stage.build || stage.check ? null : countsIn(output),
        note: stage.build ? (code === 0 ? 'built' : 'build failed')
            : stage.check ? (code === 0 ? 'clean' : 'problems found') : null,
        seconds: ((Date.now() - started) / 1000).toFixed(1)
    });
}

summarize(results);
process.exit(results.some((r) => r.outcome === 'failed') ? 1 : 0);

// ---- Setup -----------------------------------------------------------------

async function prepare(needs) {
    for (const need of needs) {
        if (prepared.has(need)) continue;
        prepared.add(need);
        const error = need === 'python' ? await preparePython() : await prepareNpm(need);
        if (error) return error;
    }
    return null;
}

async function prepareNpm(dir) {
    if (fs.existsSync(at(dir, 'node_modules'))) return null;
    const install = fs.existsSync(at(dir, 'package-lock.json')) ? ['npm', 'ci'] : ['npm', 'install'];
    const { code } = await run([...install, '--no-audit', '--no-fund'], at(dir));
    if (code !== 0) return 'npm install failed in ' + dir;
    if (dir === 'tests/e2e') {
        const browsers = await run(['npx', 'playwright', 'install', 'chromium'], at(dir));
        if (browsers.code !== 0) return 'Playwright could not install Chromium';
    }
    return null;
}

async function preparePython() {
    const venvPython = venvInterpreter();
    const probe = spawnSync(python, ['-c', 'import flask, pytest'], { cwd: at('server', 'python') });
    if (probe.status === 0) return null;
    if (python !== venvPython) {
        const created = await run([python, '-m', 'venv', '--clear', '.venv'], at('server', 'python'));
        if (created.code !== 0) return 'could not create server/python/.venv';
    }
    const installed = await run([venvPython, '-m', 'pip', 'install', '-q', '-r', 'requirements-dev.txt'], at('server', 'python'));
    if (installed.code !== 0) return 'pip install failed in server/python';
    // From here on, every Python stage uses the virtualenv.
    switchPython(venvPython);
    return null;
}

function findPython() {
    const candidates = [process.env.PYTHON, venvInterpreter(), 'python3', 'python', 'python3.13', 'python3.12', 'python3.11']
        .filter(Boolean);
    // Ubuntu's system python3 ships without ensurepip, so it cannot build the
    // virtualenv. Such an interpreter only qualifies if the packages are already there.
    const check = [
        'import importlib.util as u, sys',
        'usable = all(u.find_spec(m) for m in ("flask", "pytest")) or all(u.find_spec(m) for m in ("ensurepip", "venv"))',
        'print(sys.version_info >= (3, 11) and usable)'
    ].join('\n');
    for (const candidate of candidates) {
        const probe = spawnSync(candidate, ['-c', check], { encoding: 'utf8' });
        if (probe.status === 0 && probe.stdout.trim() === 'True') return candidate;
    }
    return null;
}

function venvInterpreter() {
    return process.platform === 'win32'
        ? at('server', 'python', '.venv', 'Scripts', 'python.exe')
        : at('server', 'python', '.venv', 'bin', 'python');
}

function switchPython(interpreter) {
    for (const stage of STAGES) {
        if (stage.run[0] === python) stage.run[0] = interpreter;
        if (stage.env === pythonServer) stage.env.SERVER_CMD = quote(interpreter) + ' -m starter_crm';
    }
}

// ---- Running and reporting -------------------------------------------------

function run(command, cwd, env) {
    return new Promise((resolve) => {
        const child = spawn(command[0], command.slice(1), {
            cwd,
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: process.platform === 'win32'
        });
        let output = '';
        const relay = (stream) => (chunk) => {
            output += chunk;
            stream.write(chunk);
        };
        child.stdout.on('data', relay(process.stdout));
        child.stderr.on('data', relay(process.stderr));
        child.on('error', (err) => resolve({ code: 1, output: output + String(err) }));
        child.on('close', (code) => resolve({ code: code === null ? 1 : code, output }));
    });
}

// Reads the totals from whichever runner the stage used: node --test,
// vitest, pytest or Playwright.
function countsIn(output) {
    // eslint-disable-next-line no-control-regex -- strips ANSI colour codes, which start with ESC
    const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
    const last = (pattern) => {
        const all = [...plain.matchAll(pattern)];
        return all.length ? Number(all[all.length - 1][1]) : 0;
    };
    return {
        passed: last(/(?:ℹ|#) pass (\d+)/g) || last(/Tests\s+(\d+) passed/g) || last(/(\d+) passed/g),
        failed: last(/(?:ℹ|#) fail (\d+)/g) || last(/(\d+) failed/g),
        skipped: last(/(?:ℹ|#) skipped (\d+)/g) || last(/(\d+) skipped/g),
        flaky: last(/(\d+) flaky/g)
    };
}

function summarize(list) {
    console.log('\n' + '='.repeat(72) + '\nSummary\n' + '='.repeat(72));
    for (const r of list) {
        const counts = r.counts
            ? r.counts.passed + ' passed, ' + r.counts.failed + ' failed'
                + (r.counts.skipped ? ', ' + r.counts.skipped + ' skipped' : '')
                + (r.counts.flaky ? ', ' + r.counts.flaky + ' flaky' : '')
                + '  (' + r.seconds + ' s)'
            : r.note + (r.seconds ? '  (' + r.seconds + ' s)' : '');
        console.log((r.outcome === 'passed' ? 'PASS ' : r.outcome === 'failed' ? 'FAIL ' : 'SKIP ') + r.name.padEnd(22) + counts);
    }
}

function banner(name) {
    console.log('\n' + '-'.repeat(72) + '\n' + name + '\n' + '-'.repeat(72));
}

function valueOf(flag) {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
}

function quote(file) {
    return /\s/.test(file) ? '"' + file + '"' : file;
}
