// Builds what the Next.js variant serves, then Next itself.
//
// Where it sits: `npm run build` here, and Vercel's build command. The React front-end is built into react/dist (the core
// serves it from there, like the Node server does); the vanilla front-end needs no build. Dependencies of ../node and
// ../../react are installed by Vercel's install command (see vercel.json) and by `npm test` locally.
// What a customer changes: nothing.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const nextjs = path.resolve(here, '..');
const react = path.resolve(nextjs, '..', '..', 'react');

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

run('npm', ['run', 'build'], react);
run('npx', ['next', 'build'], nextjs);
