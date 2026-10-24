/**
 * Shared plumbing for `npm run deploy:aws` and `npm run destroy:aws`.
 *
 * Where it sits: both scripts run the AWS CLI through `exec`, so a test can hand them a fake and prove what they
 * would run without an account. Nothing here calls AWS on its own.
 *
 * What a customer changes: nothing.
 */

import { spawnSync } from 'node:child_process';

/** The stack name CloudFormation accepts: a letter, then letters, digits and dashes, 128 at most. */
export const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;

/** A UUID, which is what Drop Cowboy accepts as a site id. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs a command and captures its output. The default `exec` of both scripts.
 *
 * @param {string} command The program.
 * @param {string[]} args Its arguments.
 * @returns {{ status: number, stdout: string, stderr: string }} How it ended; status is 127 when it could not start.
 */
export function execFile(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.error) return { status: 127, stdout: '', stderr: result.error.message };
    return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/**
 * Reads `--name value`, `--name=value` and `--flag` arguments.
 *
 * @param {string[]} argv The arguments after the script name.
 * @param {{ values: string[], flags: string[] }} known The options that take a value and those that do not.
 * @returns {Record<string, string|boolean>} The options by name, without the dashes.
 * @throws {Error} For an option that is not known, or a value that is missing.
 */
export function readArgs(argv, known) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const raw = argv[i];
        if (!raw.startsWith('--')) throw new Error('Unexpected argument "' + raw + '". Options start with --.');
        const eq = raw.indexOf('=');
        const name = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
        if (known.flags.includes(name)) {
            if (eq !== -1) throw new Error('--' + name + ' does not take a value.');
            out[name] = true;
        } else if (known.values.includes(name)) {
            const value = eq === -1 ? argv[++i] : raw.slice(eq + 1);
            if (value === undefined || (eq === -1 && value.startsWith('--'))) throw new Error('--' + name + ' needs a value.');
            out[name] = value;
        } else {
            throw new Error('Unknown option --' + name + '.');
        }
    }
    return out;
}

/**
 * The CLI arguments that choose the region, when one is given.
 *
 * @param {string|null} region The region, or null to use the CLI's own.
 * @returns {string[]} `['--region', region]` or nothing.
 */
export function regionArgs(region) {
    return region ? ['--region', region] : [];
}

/**
 * Runs an AWS CLI command and returns its output, or throws with what it said.
 *
 * @param {Function} exec The command runner.
 * @param {string[]} args The arguments after `aws`.
 * @returns {string} Standard output.
 * @throws {Error} When the CLI exits non-zero or cannot start.
 */
export function aws(exec, args) {
    const result = exec('aws', args);
    if (result.status !== 0) {
        const said = (result.stderr || result.stdout || '').trim();
        throw new Error('aws ' + args.slice(0, 2).join(' ') + ' failed' + (said ? ': ' + said : '.'));
    }
    return result.stdout;
}

/**
 * Reads a stack, or reports that it does not exist.
 *
 * @param {Function} exec The command runner.
 * @param {string} name The stack name.
 * @param {string|null} region The region.
 * @returns {{ Parameters?: object[], Outputs?: object[], StackStatus: string }|null} The stack, or null when there is none.
 * @throws {Error} For any failure other than a missing stack.
 */
export function describeStack(exec, name, region) {
    const result = exec('aws', ['cloudformation', 'describe-stacks', '--stack-name', name, '--output', 'json', ...regionArgs(region)]);
    if (result.status !== 0) {
        if (/does not exist/i.test(result.stderr || '')) return null;
        throw new Error('aws cloudformation describe-stacks failed: ' + (result.stderr || result.stdout || 'no output').trim());
    }
    const stacks = JSON.parse(result.stdout).Stacks || [];
    return stacks[0] || null;
}

/**
 * The outputs of a stack by key.
 *
 * @param {{ Outputs?: object[] }} stack A stack as `describe-stacks` returns it.
 * @returns {Record<string, string>} Output values by output key.
 */
export function outputsOf(stack) {
    const out = {};
    for (const item of stack.Outputs || []) out[item.OutputKey] = item.OutputValue;
    return out;
}
