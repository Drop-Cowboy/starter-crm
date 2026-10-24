// Builds what Netlify's CDN serves: the front-ends, and the headers they are served with.
//
// Where it sits: the build command in netlify.toml, after it has installed ../node, ../../react and this folder. It
// builds the React front-end, then assembles dist/ the way the core lays out its static files: the vanilla front-end
// at `/`, the React build at `/react/` and the shared modules at `/shared/`. Names starting with `.` and node_modules
// folders are left out, as the core refuses to serve them. Last it writes `_headers` (lib/cdn-headers.js).
//
// Netlify passes the site's variables to the build as well as to the functions, and applies a change to either only on
// the next deploy, so the CDN's headers and the function's stay in step. What a customer changes: nothing.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../node/src/config.js';
import { headersFile } from '../lib/cdn-headers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const netlify = path.resolve(here, '..');
const root = path.resolve(netlify, '..', '..');
const dist = path.join(netlify, 'dist');

/**
 * Runs a command and stops the build when it fails.
 *
 * @param {string} command The program.
 * @param {string[]} args Its arguments.
 * @param {string} cwd Where to run it.
 */
function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
}

/**
 * Copies a folder, leaving out hidden names and node_modules.
 *
 * @param {string} from The folder to copy.
 * @param {string} to Where its contents go.
 */
function copyTree(from, to) {
    fs.cpSync(from, to, {
        recursive: true,
        filter: (source) => {
            const name = path.basename(source);
            return source === from || (!name.startsWith('.') && name !== 'node_modules');
        }
    });
}

/**
 * @param {string} dir The assembled dist/ folder.
 * @returns {string[]} Every file in it, as a URL path such as `/react/index.html`.
 */
function listFiles(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        files.push('/' + path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
    }
    return files;
}

run('npm', ['run', 'build'], path.join(root, 'react'));

fs.rmSync(dist, { recursive: true, force: true });
copyTree(path.join(root, 'vanilla'), dist);
copyTree(path.join(root, 'react', 'dist'), path.join(dist, 'react'));
copyTree(path.join(root, 'shared'), path.join(dist, 'shared'));

// The headers depend only on settings that are plain variables, so a problem elsewhere (a secret the functions load
// from a manager at run time) does not stop the build: the functions report it when they boot. Netlify's own builds set
// NETLIFY, which makes DC_ENV default to production as it does in the functions; `netlify build` on a laptop does not,
// so it is set here too.
const env = Object.assign({}, process.env, { NETLIFY: process.env.NETLIFY || 'true' });
const { config } = loadConfig(env, root);
fs.writeFileSync(path.join(dist, '_headers'), headersFile(config, listFiles(dist)));
console.log('Assembled ' + path.relative(root, dist) + ' for the CDN.');
