/**
 * Command line for the provider conformance checks (Node).
 *
 *   npm run conformance:provider -- <kind> <path> [NAME=value ...]
 *
 * <path> may also be a built-in name such as `oidc` or `memory`.
 *
 * Where it sits: a thin wrapper around check.js that supplies the starter's
 * config loader and prints one line per check. `NAME=value` arguments become
 * settings the provider reads (for example `DC_PASSCODE=...`). Exits 1 when
 * any check fails.
 *
 * CONTRACT.md: "Providers".
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkProvider } from './check.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const { loadConfig } = await import(pathToFileURL(path.join(root, 'server', 'node', 'src', 'config.js')).href);

const [kind, file, ...settings] = process.argv.slice(2);
if (!kind || !file) {
    console.error('Usage: npm run conformance:provider -- <identity|secrets|ratelimit|log|observer> <path-or-built-in-name> [NAME=value ...]');
    process.exit(2);
}
const env = {};
for (const setting of settings) {
    const eq = setting.indexOf('=');
    if (eq < 1) {
        console.error('Settings look like NAME=value (got "' + setting + '").');
        process.exit(2);
    }
    env[setting.slice(0, eq)] = setting.slice(eq + 1);
}

const { BUILTINS } = await import(pathToFileURL(path.join(root, 'server', 'node', 'src', 'providers', 'index.js')).href);

const results = await checkProvider(kind, file, { env, loadConfig, root, builtins: BUILTINS });
let failed = 0;
for (const result of results) {
    console.log((result.ok ? 'ok     ' : 'FAILED ') + result.name + (result.ok ? '' : '\n         ' + result.detail));
    if (!result.ok) failed++;
}
console.log('\n' + (results.length - failed) + ' of ' + results.length + ' checks passed.');
process.exit(failed === 0 ? 0 : 1);
