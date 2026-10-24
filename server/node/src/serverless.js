/**
 * Boots the core for a host that has no process of its own: a Next.js route handler, a Netlify function.
 *
 * Where it sits: `server/nextjs` imports this file at run time (never through the bundler, because the core reads its
 * migrations, schemas and front-end files from disk) and calls `bootCore()` on the first request. It does what
 * `index.js` does except listen, start the maintenance loop or handle signals: a serverless instance has no loop
 * between requests, so every piece of work is done inside a request and awaited there.
 *
 * CONTRACT.md: "Boot", "Internal routes".
 * What a customer changes: nothing.
 */

import path from 'node:path';
import dotenv from 'dotenv';
import { bootstrap } from './bootstrap.js';
import { starterRoot } from './config.js';
import { createCore } from './core.js';
import { formatProblems } from './problems.js';

/**
 * Boots the configuration, providers and core.
 *
 * @param {NodeJS.ProcessEnv} [env] The environment; variables already in it win over `.env`.
 * @returns {Promise<{ ok: true, core: object, config: object, log: object }
 *   | { ok: false, problems: object[], text: string }>} The booted core, or every problem found. A caller must not
 *   cache the second shape: the next request may find the environment fixed.
 */
export async function bootCore(env = process.env) {
    const root = starterRoot(env);
    dotenv.config({ path: path.join(root, '.env'), quiet: true, processEnv: env });
    const booted = await bootstrap(env, root);
    if (booted.problems.length > 0) {
        return { ok: false, problems: booted.problems, text: formatProblems(booted.problems) };
    }
    const core = createCore(booted.config, {
        log: booted.log,
        identity: booted.identity || undefined,
        ratelimit: booted.ratelimit,
        observer: booted.observer || undefined,
        secrets: booted.secrets || undefined,
        runtime: booted.runtime
    });
    return { ok: true, core, config: booted.config, log: booted.log };
}
