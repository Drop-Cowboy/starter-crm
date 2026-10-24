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

/**
 * Stops a server with SIGTERM and waits for every process it started to be gone.
 *
 * The shell that runs SERVER_CMD exits as soon as it is signalled, so waiting for it alone would
 * say "stopped" while the server itself was still stuck in its shutdown. This waits for the whole
 * process group, kills what is left after 5 seconds, and then reports it as a failure.
 *
 * @param {{ child: import('node:child_process').ChildProcess, exited: Promise<unknown> }} proc The server from spawnServer().
 * @returns {Promise<void>}
 * @throws {Error} When the server did not exit within 5 seconds of SIGTERM.
 */
export async function stopServer(proc) {
    if (proc.child.exitCode === null && proc.child.signalCode === null) {
        signal(proc.child, 'SIGTERM');
        await proc.exited;
    }
    const deadline = Date.now() + 5000;
    while (groupAlive(proc.child) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (groupAlive(proc.child)) {
        signal(proc.child, 'SIGKILL');
        throw new Error('The server did not exit within 5 seconds of SIGTERM, so it was killed.\n' + proc.output());
    }
}

function groupAlive(child) {
    if (process.platform === 'win32') return false;
    try {
        process.kill(-child.pid, 0);
        return true;
    } catch {
        return false;
    }
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
