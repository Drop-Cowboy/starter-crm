#!/usr/bin/env node
/**
 * `npm run new:module -- tickets` makes a module of your own on both servers.
 *
 * Where it sits: starter root. It writes three files from `scripts/templates/module/`:
 * `server/node/src/modules/<id>/index.js`, `server/python/starter_crm/modules/<id>.py` and `server/schemas/<id>.json`.
 * The module is a small list of titled items (title, notes, done) with create, read, update and delete, kept per user in the
 * data API. Change the fields in the schema and both servers. It never overwrites a file.
 *
 *   npm run new:module -- tickets
 *   npm run new:module -- staff --singular staff-member
 *
 * CUSTOMIZE.md: "Add a module".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');

const MODULE_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** Ids the app already uses for its own routes. */
const RESERVED = new Set(['add']);

/**
 * Guesses the singular of a module id: `tickets` is a `ticket`, `categories` a `category`.
 *
 * @param {string} id The module id.
 * @returns {string | null} The singular, or null when the id does not look like a plural.
 */
export function singularOf(id) {
    if (id.endsWith('ies') && id.length > 4) return id.slice(0, -3) + 'y';
    if (id.endsWith('s') && !id.endsWith('ss') && id.length > 1) return id.slice(0, -1);
    return null;
}

/**
 * @param {string} words Lowercase words joined by dashes.
 * @returns {string} The words with a capital on each: `support-tickets` is `Support Tickets`.
 */
function titleCase(words) {
    return words.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

/**
 * Writes the three files of a new module.
 *
 * @param {{ root?: string, id: string, singular?: string }} options `root` is the starter folder; `singular` names one item.
 * @returns {{ files: string[], id: string, collection: string, item: string }} What was written, relative to the root.
 * @throws {Error} With a message that says what to change, when the id is unusable or a file already exists.
 */
export function scaffold({ root = DEFAULT_ROOT, id, singular }) {
    if (typeof id !== 'string' || !MODULE_ID.test(id) || id.endsWith('-')) {
        throw new Error('A module id is lowercase letters, digits and dashes, starting with a letter and at most 32 long, such as "tickets" (got ' + JSON.stringify(id) + ').');
    }
    if (RESERVED.has(id)) {
        throw new Error('"' + id + '" is already used by the app. Pick another id.');
    }
    const itemId = singular || singularOf(id);
    if (!itemId) {
        throw new Error('Cannot tell what one "' + id + '" is called. Say it: npm run new:module -- ' + id + ' --singular <name>.');
    }
    if (!MODULE_ID.test(itemId) || itemId.endsWith('-')) {
        throw new Error('--singular is lowercase letters, digits and dashes, such as "ticket" (got ' + JSON.stringify(itemId) + ').');
    }

    const collection = id.replaceAll('-', '_');
    const item = itemId.replaceAll('-', ' ');
    const tokens = [
        ['__ITEMS_SNAKE__', collection],
        ['__ITEM_SNAKE__', itemId.replaceAll('-', '_')],
        ['__COLLECTION__', collection],
        ['__MODULE__', id],
        ['__LABEL__', titleCase(id)],
        ['__ITEMS__', id.replaceAll('-', ' ')],
        ['__ITEM__', item]
    ];
    const fill = (text) => tokens.reduce((out, [token, value]) => out.replaceAll(token, value), text);

    const targets = [
        ['node.js.tmpl', path.join('server', 'node', 'src', 'modules', id, 'index.js')],
        ['python.py.tmpl', path.join('server', 'python', 'starter_crm', 'modules', collection + '.py')],
        ['schema.json.tmpl', path.join('server', 'schemas', id + '.json')]
    ];
    for (const [, target] of targets) {
        if (fs.existsSync(path.join(root, target))) {
            throw new Error(target + ' already exists. Nothing was written; pick another id or remove it first.');
        }
    }
    for (const [template, target] of targets) {
        const text = fs.readFileSync(path.join(HERE, 'templates', 'module', template), 'utf8');
        const file = path.join(root, target);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, fill(text), { flag: 'wx' });
    }
    return { files: targets.map(([, target]) => target), id, collection, item };
}

/**
 * Reads `<id> [--singular <name>]` from the command line.
 *
 * @param {string[]} argv The arguments after the script name.
 * @returns {{ id?: string, singular?: string }} The parsed options.
 */
export function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--singular') {
            out.singular = argv[++i];
        } else if (arg.startsWith('--singular=')) {
            out.singular = arg.slice('--singular='.length);
        } else if (!arg.startsWith('-') && out.id === undefined) {
            out.id = arg;
        } else {
            throw new Error('Unexpected argument ' + JSON.stringify(arg) + '. Usage: npm run new:module -- <id> [--singular <name>].');
        }
    }
    return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const { id, singular } = parseArgs(process.argv.slice(2));
        if (!id) throw new Error('Name the module: npm run new:module -- tickets');
        const result = scaffold({ id, singular });
        console.log('Made the "' + result.id + '" module:');
        for (const file of result.files) console.log('  ' + file);
        console.log('\nNext:');
        console.log('  1. Restart the server (npm run dev). Routes are under /api/modules/' + result.id + '.');
        console.log('  2. Change the fields in server/schemas/' + result.id + '.json and in both servers together.');
        console.log('  3. Build the screen: an entry in shared/ui.js MODULES, a page in vanilla/pages/ and react/src/pages/');
        console.log('     (deals.js and DealsPage.jsx are the example), and a branch for its id in vanilla/pages/module.js');
        console.log('     and react/src/pages/ModulePage.jsx, next to the one for deals.');
        console.log('  4. Test it against both servers: server/conformance/suite/22-modules-deals.test.js is the example.');
    } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
    }
}
