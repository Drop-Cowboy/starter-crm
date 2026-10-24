/**
 * Operator commands for the event store: `npm run webhooks:replay`, `webhooks:failed`
 * and `migrate:status` at the starter root call this file.
 *
 * Where it sits: it boots the same config and providers as the server (so it needs the
 * same `.env`), runs one command against the store, and exits. Nothing here serves HTTP.
 *
 *   node src/cli.js failed                      list events that used up their attempts
 *   node src/cli.js replay <event_id>           run one failed event's handlers again
 *   node src/cli.js replay --all-failed         run every failed event again
 *   node src/cli.js migrate:status              list which migrations have run
 *
 * `replay` puts the event back in the outbox (or the queue) and, when this process has a
 * worker, handles it before exiting; with `DC_WORKER_IN_PROCESS=off` it only re-queues,
 * and `npm run worker` does the rest.
 *
 * CONTRACT.md: "Event store" (Replay, Migrations).
 * What a customer changes: nothing.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { bootstrap } from './bootstrap.js';
import { starterRoot } from './config.js';
import { migrationStatus } from './migrations.js';
import { formatProblems } from './problems.js';

/** The longest `replay` waits for its own worker to finish what it queued. */
const REPLAY_WAIT_MS = 30000;

/**
 * Prints the usage text.
 *
 * @returns {void}
 */
function usage() {
    console.error('Usage: node src/cli.js failed | replay <event_id> | replay --all-failed | migrate:status');
}

/**
 * Lists failed events.
 *
 * @param {object} runtime The event runtime.
 * @returns {Promise<number>} The exit code.
 */
async function failed(runtime) {
    const rows = await runtime.store.listFailed({ limit: 200 });
    if (rows.length === 0) {
        console.log('No failed events.');
        return 0;
    }
    for (const row of rows) {
        console.log(row.event_id + '  ' + row.event + '  attempts=' + row.attempts + '  ' + (row.last_error || ''));
    }
    return 0;
}

/**
 * Puts failed events back to `received` and runs them.
 *
 * @param {object} runtime The event runtime.
 * @param {string[]} args The command's arguments: an event id, or `--all-failed`.
 * @param {object} config The loaded config.
 * @returns {Promise<number>} The exit code.
 */
async function replay(runtime, args, config) {
    if (!args[0]) {
        usage();
        return 2;
    }
    const ids = args[0] === '--all-failed'
        ? (await runtime.store.listFailed({ limit: 200 })).map((row) => row.event_id)
        : [args[0]];
    const queued = [];
    for (const id of ids) {
        if (await runtime.store.replay(id)) {
            queued.push(id);
            await runtime.dispatcher.dispatch(id);
            console.log('Re-queued ' + id);
        } else {
            console.error(id + ' is not a failed event, so it was not replayed.');
        }
    }
    if (queued.length === 0) return ids.length === 0 ? 0 : 1;
    if (!config.events.workerInProcess) {
        console.log('Run `npm run worker` (or let your web instances\' worker) finish ' + queued.length + ' event(s).');
        return 0;
    }
    // This process has a worker (started below the call), so wait for it.
    const deadline = Date.now() + REPLAY_WAIT_MS;
    let code = 0;
    for (const id of queued) {
        for (;;) {
            const row = await runtime.store.get(id);
            if (row && row.status !== 'received') {
                console.log(id + ' ' + row.status);
                if (row.status === 'failed') code = 1;
                break;
            }
            if (Date.now() > deadline) {
                console.error(id + ' is still waiting after ' + REPLAY_WAIT_MS / 1000 + ' seconds.');
                code = 1;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 200));
        }
    }
    return code;
}

/**
 * Lists applied and pending migrations for a SQL store (or SQL module data behind a Redis store).
 *
 * @param {object} config The loaded config.
 * @param {object} runtime The event runtime.
 * @returns {Promise<number>} The exit code.
 */
async function migrations(config, runtime) {
    // The store and the module data share one migrations table when both are SQL; with a Redis store, the data provider owns the tables.
    const sql = ['sqlite', 'postgres'];
    let kind = config.events.store;
    let owner = runtime.store;
    if (!sql.includes(kind) && sql.includes(config.data.provider)) {
        kind = config.data.provider;
        owner = runtime.data;
    }
    if (!sql.includes(kind)) {
        console.log('DC_STORE=' + kind + ' has no migrations.');
        return 0;
    }
    const names = await owner.appliedMigrations();
    const status = migrationStatus(names, kind);
    for (const name of status.applied) console.log('applied  ' + name);
    for (const name of status.pending) console.log('pending  ' + name);
    return status.pending.length > 0 ? 1 : 0;
}

const root = starterRoot(process.env);
dotenv.config({ path: path.join(root, '.env'), quiet: true });
const [command, ...rest] = process.argv.slice(2);
if (!['failed', 'replay', 'migrate:status'].includes(command)) {
    usage();
    process.exit(2);
}

const booted = await bootstrap(process.env, root);
if (booted.problems.length > 0) {
    console.error('The command cannot run:\n' + formatProblems(booted.problems));
    process.exit(1);
}

let code = 1;
try {
    if (command === 'failed') code = await failed(booted.runtime);
    if (command === 'migrate:status') code = await migrations(booted.config, booted.runtime);
    if (command === 'replay') {
        // A replay waits for a worker, so start one here unless it is configured to run elsewhere.
        await booted.runtime.start();
        code = await replay(booted.runtime, rest, booted.config);
    }
} catch (err) {
    console.error('The command failed: ' + (err && err.message ? err.message : 'unknown error'));
} finally {
    await booted.runtime.stop();
}
process.exit(code);
