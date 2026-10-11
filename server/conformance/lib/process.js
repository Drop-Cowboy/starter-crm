import { spawn } from 'node:child_process';
import net from 'node:net';

// Only these are inherited from your shell, so a .env or exported variable on
// your machine can't change what a server under test sees.
const PASSTHROUGH = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'VIRTUAL_ENV', 'PYTHONPATH'];

export function baseEnv() {
    const env = { PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' };
    for (const name of PASSTHROUGH) {
        if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    return env;
}

export function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

// Runs `command` through the shell so SERVER_CMD can be any command line,
// for example "python -m starter_crm". Output is captured for the leak check.
export function spawnServer({ command, cwd, env }) {
    const child = spawn(command, {
        cwd,
        env,
        shell: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    return { child, exited, output: () => output };
}

export async function stopServer(proc) {
    if (proc.child.exitCode !== null || proc.child.signalCode !== null) return;
    signal(proc.child, 'SIGTERM');
    const timer = setTimeout(() => signal(proc.child, 'SIGKILL'), 5000);
    await proc.exited;
    clearTimeout(timer);
}

export async function waitForHealth(url, proc, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    let exited = null;
    proc.exited.then((result) => { exited = result; });
    while (Date.now() < deadline) {
        if (exited) {
            throw new Error('Server exited (' + JSON.stringify(exited) + ') before /healthz answered.\n' + proc.output());
        }
        const ok = await fetch(url + '/healthz').then((res) => res.ok, () => false);
        if (ok) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Server did not answer /healthz within ' + timeoutMs + ' ms.\n' + proc.output());
}

function signal(child, name) {
    try {
        // Negative pid: the whole process group, so the shell's child dies too.
        if (process.platform === 'win32') child.kill(name);
        else process.kill(-child.pid, name);
    } catch {
        // Already gone.
    }
}
