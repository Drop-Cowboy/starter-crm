/**
 * The `file` secrets provider: one file per secret under `DC_SECRETS_DIR`.
 *
 * Where it sits: `DC_SECRETS=file`. It covers Docker and Compose secrets
 * (`/run/secrets`), where the
 * platform mounts each secret as a file named after it. A file's name is the
 * variable name (`DROPCOWBOY_API_KEY`) and its content is the value, with
 * surrounding whitespace removed. Files are re-read on every refresh, so a
 * rotated mounted file is picked up without a restart.
 *
 * CONTRACT.md: "Providers" (secrets).
 * Env: DC_SECRETS_DIR (required): the folder of secret files.
 * What a customer changes: nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { problem } from '../../problems.js';

export const name = 'file';
export const configKeys = ['DC_SECRETS_DIR'];

/** Only names shaped like environment variables are read, so a name can never walk out of the folder. */
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Checks `DC_SECRETS_DIR` is set and is a readable folder.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    const dir = typeof env.DC_SECRETS_DIR === 'string' ? env.DC_SECRETS_DIR.trim() : '';
    const fix = 'Set DC_SECRETS_DIR to the folder holding one file per secret, such as /run/secrets.';
    if (!dir) {
        return [problem('missing_secrets_dir', 'DC_SECRETS=file needs DC_SECRETS_DIR.', fix)];
    }
    try {
        fs.accessSync(dir, fs.constants.R_OK);
        if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory');
    } catch {
        return [problem('missing_secrets_dir', 'DC_SECRETS_DIR (' + dir + ') is not a readable folder.', fix)];
    }
    return [];
}

/**
 * Creates the provider.
 *
 * @param {{ env: NodeJS.ProcessEnv, log: { warn: Function } }} ctx Provider context.
 * @returns {{ load: (names: string[]) => Promise<Record<string, string>>, refresh: () => Promise<Record<string, string>> }}
 *   The instance.
 */
export function create(ctx) {
    const dir = path.resolve(ctx.env.DC_SECRETS_DIR.trim());
    let lastNames = [];
    const warned = new Set();

    async function read(names) {
        const values = {};
        for (const secretName of names) {
            if (!SAFE_NAME.test(secretName)) continue;
            const file = path.join(dir, secretName);
            let stat;
            try {
                stat = await fs.promises.stat(file);
            } catch {
                continue;
            }
            if (!stat.isFile()) continue;
            // Others being able to read a secret is worth saying once per file.
            if ((stat.mode & 0o004) !== 0 && !warned.has(file)) {
                warned.add(file);
                await ctx.log.warn('Secret file ' + file + ' is world-readable. Restrict it, for example chmod 600.');
            }
            const value = (await fs.promises.readFile(file, 'utf8')).trim();
            if (value) values[secretName] = value;
        }
        return values;
    }

    return {
        async load(names) {
            lastNames = names;
            return read(names);
        },
        async refresh() {
            return read(lastNames);
        }
    };
}
