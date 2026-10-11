#!/usr/bin/env node
// Checks text that is about to be published for things that must stay private:
// customer names, internal service and field names, real email addresses and
// phone numbers, and AWS resources. It prints one line per hit as
// file:line:column and exits 1 when there is any.
//
//   node scripts/public-content-check.mjs                 check everything sync-to-hub.mjs would copy
//   node scripts/public-content-check.mjs <path>...       check these files or directories
//
// Options: --source <examples root> (with no paths), --denylist <file>,
// --patterns-only, --help.
// The terms live in public-content-denylist.json next to this script. The
// checker is published (sync-to-hub.mjs copies it to the hub's .github/scripts);
// the denylist never is. Hub CI reads the denylist from an Actions secret and
// passes it with --denylist. Where that secret is not available, as on pull
// requests from forks, --patterns-only runs every check except the terms.
//
// What counts as a hit:
//   term            a denylist term, case-insensitive
//   email           an address whose domain is not an allowed domain or a subdomain of one
//   phone           a NANP number in E.164 (+1NXXNXXXXXX) whose exchange is not 555,
//                   other than the simulated +1555001xxxx and +1555002xxxx ranges
//   aws_arn         anything starting arn:aws
//   aws_account_id  a standalone 12-digit number outside a UUID, or a listed account id anywhere
//   aws_host        an amazonaws.com or on.aws host name
//   closed_source   a Building Blocks bundle or manifest. Building Blocks are
//                   closed source; the Starter CRM's tests download them instead.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES = path.resolve(SCRIPT_DIR, '..');
const DENYLIST_PATH = path.join(SCRIPT_DIR, 'public-content-denylist.json');

// Directories never walked when a directory is given on the command line.
const SKIPPED_DIRS = new Set([
    'node_modules', '.git', '.venv', 'venv', '__pycache__', '.pytest_cache', '.ruff_cache',
    '.mypy_cache', 'bin', 'obj', 'coverage', 'TestResults', 'dist', '.vs', '.idea', '.vscode'
]);

const PATTERNS_ONLY_EMAIL_DOMAINS = ['example.com', 'example.org', 'dropcowboy.com'];

const MAX_SHOWN = 80;
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,})(?![A-Za-z0-9-])/g;
const PHONE_PATTERN = /(?<!\d)\+1(\d{3})(\d{3})(\d{4})(?!\d)/g;
const ARN_PATTERN = /arn:aws[a-z-]*:[^\s"'`<>)\]]*/gi;
const ACCOUNT_PATTERN = /(?<![0-9A-Za-z+.-])\d{12}(?![0-9A-Za-z.-])/g;
const AWS_HOST_PATTERN = /[A-Za-z0-9.-]*(?:\.amazonaws\.com|\.on\.aws)(?![A-Za-z0-9-])/gi;
const BUILDING_BLOCKS_BANNER = /^\/\*!\s*Drop Cowboy Building Blocks/;
const BUILDING_BLOCKS_MANIFEST = 'building-blocks-manifest.json';

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A term with a space, hyphen or underscore also matches the other two and
// no separator at all, so "acme widgets" catches AcmeWidgets and
// acme_widgets too.
function termPattern(term) {
    const pieces = term.trim().split(/[\s_-]+/).map(escapeRegExp);
    return new RegExp(pieces.join('[\\s_-]?'), 'gi');
}

// Reads and validates the denylist. Throws an Error with a readable message.
function loadDenylist(file) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error('Could not read the denylist ' + file + ': ' + error.message);
    }
    const terms = Array.isArray(parsed.terms) ? parsed.terms.filter((t) => typeof t === 'string' && t.trim() !== '') : [];
    if (terms.length === 0) {
        throw new Error('The denylist ' + file + ' has no terms, so nothing would be checked.');
    }
    const domains = Array.isArray(parsed.allowed_email_domains) ? parsed.allowed_email_domains : [];
    const accounts = Array.isArray(parsed.aws_account_ids) ? parsed.aws_account_ids : [];
    return {
        terms: terms.map((term) => ({ term: term, pattern: termPattern(term) })),
        allowedEmailDomains: domains.map((d) => String(d).toLowerCase()),
        awsAccountIds: accounts.map((a) => String(a))
    };
}

// The checks that need no denylist: emails, phone numbers and AWS resources.
function patternsOnlyDenylist() {
    return { terms: [], allowedEmailDomains: PATTERNS_ONLY_EMAIL_DOMAINS.slice(), awsAccountIds: [] };
}

function isAllowedEmailDomain(domain, allowed) {
    const lower = domain.toLowerCase();
    for (const ok of allowed) {
        if (lower === ok || lower.endsWith('.' + ok)) return true;
    }
    return false;
}

// The send API's simulated voice (+1 555 001-xxxx) and text (+1 555 002-xxxx)
// ranges. Area code 555 is unassigned, so they reach no one.
function isSimulatedNumber(m) {
    return m[1] === '555' && (m[2] === '001' || m[2] === '002');
}

function shown(text) {
    const ascii = text.replace(/[^\x20-\x7e]/g, '?');
    return ascii.length > MAX_SHOWN ? ascii.slice(0, MAX_SHOWN) + '...' : ascii;
}

function matchesOf(pattern, line) {
    pattern.lastIndex = 0;
    return Array.from(line.matchAll(pattern));
}

// Drops a hit whose range lies inside another hit of the same category, so
// "acmewidgets" is reported once rather than also as "acme".
function dropNested(hits) {
    const sorted = hits.slice().sort((a, b) => a.start - b.start || b.end - a.end);
    const kept = [];
    for (const hit of sorted) {
        const inside = kept.some((k) => k.category === hit.category && k.start <= hit.start && hit.end <= k.end);
        if (!inside) kept.push(hit);
    }
    return kept;
}

function scanLine(line, denylist) {
    const hits = [];
    const add = (category, start, text, detail) => {
        hits.push({ category: category, start: start, end: start + text.length, match: text, detail: detail || null });
    };
    for (const entry of denylist.terms) {
        for (const m of matchesOf(entry.pattern, line)) add('term', m.index, m[0], entry.term);
    }
    for (const m of matchesOf(EMAIL_PATTERN, line)) {
        if (!isAllowedEmailDomain(m[1], denylist.allowedEmailDomains)) add('email', m.index, m[0]);
    }
    for (const m of matchesOf(PHONE_PATTERN, line)) {
        if (m[2] !== '555' && !isSimulatedNumber(m)) add('phone', m.index, m[0]);
    }
    for (const m of matchesOf(ARN_PATTERN, line)) add('aws_arn', m.index, m[0]);
    for (const m of matchesOf(AWS_HOST_PATTERN, line)) add('aws_host', m.index, m[0]);

    const masked = line.replace(UUID_PATTERN, (uuid) => ' '.repeat(uuid.length));
    for (const m of matchesOf(ACCOUNT_PATTERN, masked)) add('aws_account_id', m.index, m[0]);
    for (const id of denylist.awsAccountIds) {
        let at = line.indexOf(id);
        while (at !== -1) {
            add('aws_account_id', at, id);
            at = line.indexOf(id, at + id.length);
        }
    }
    return dropNested(hits).sort((a, b) => a.start - b.start);
}

// Returns [{ line, column, category, match, detail }] for one text, with
// 1-based line and column numbers.
function scanText({ text, denylist }) {
    const found = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        for (const hit of scanLine(lines[i], denylist)) {
            found.push({ line: i + 1, column: hit.start + 1, category: hit.category, match: hit.match, detail: hit.detail });
        }
    }
    return found;
}

// Returns what identifies a Building Blocks file, or null.
function closedSourceMatch(abs, buffer) {
    if (path.basename(abs) === BUILDING_BLOCKS_MANIFEST) return BUILDING_BLOCKS_MANIFEST;
    const head = buffer.subarray(0, 200).toString('utf8');
    const banner = head.match(BUILDING_BLOCKS_BANNER);
    return banner ? banner[0] : null;
}

function isBinary(buffer) {
    const length = Math.min(buffer.length, 8000);
    for (let i = 0; i < length; i++) {
        if (buffer[i] === 0) return true;
    }
    return false;
}

// files: [{ display, abs }]. Returns { hits: [{ file, line, column, category,
// match, detail }], scanned, skipped: [display] }.
function scanFiles({ files, denylist }) {
    const hits = [];
    const skipped = [];
    let scanned = 0;
    for (const file of files) {
        const buffer = fs.readFileSync(file.abs);
        const closedSource = closedSourceMatch(file.abs, buffer);
        if (closedSource) {
            scanned++;
            hits.push({ file: file.display, line: 1, column: 1, category: 'closed_source', match: closedSource, detail: null });
            continue;
        }
        if (isBinary(buffer)) {
            skipped.push(file.display);
            continue;
        }
        scanned++;
        for (const hit of scanText({ text: buffer.toString('utf8'), denylist: denylist })) {
            hits.push({ file: file.display, line: hit.line, column: hit.column, category: hit.category, match: hit.match, detail: hit.detail });
        }
    }
    return { hits: hits, scanned: scanned, skipped: skipped };
}

function formatHit(hit) {
    let label = hit.category;
    if (hit.category === 'term' && hit.detail && hit.detail.toLowerCase() !== hit.match.toLowerCase()) {
        label += ' "' + hit.detail + '"';
    }
    return hit.file + ':' + hit.line + ':' + hit.column + ': ' + label + ': ' + shown(hit.match);
}

function formatHits(result) {
    const lines = [];
    for (const hit of result.hits) lines.push(formatHit(hit));
    const files = new Set(result.hits.map((h) => h.file)).size;
    if (result.hits.length === 0) {
        lines.push('Public content check: no hits in ' + result.scanned + ' files.');
    } else {
        lines.push('Public content check: ' + result.hits.length + ' hit' + (result.hits.length === 1 ? '' : 's')
            + ' in ' + files + ' file' + (files === 1 ? '' : 's') + ' (' + result.scanned + ' checked).');
    }
    for (const name of result.skipped) lines.push('Skipped a binary file: ' + name);
    return lines.join('\n');
}

function walkFiles(root) {
    const found = [];
    function visit(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
            const abs = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!SKIPPED_DIRS.has(entry.name)) visit(abs);
            } else if (entry.isFile()) {
                found.push(abs);
            }
        }
    }
    visit(root);
    return found;
}

function displayName(abs, cwd) {
    const rel = path.relative(cwd, abs);
    return (rel && !rel.startsWith('..') ? rel : abs).split(path.sep).join('/');
}

function parseArgs(argv) {
    const parsed = { paths: [], source: null, denylist: null, patternsOnly: false, help: false, error: null };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') parsed.help = true;
        else if (arg === '--patterns-only') parsed.patternsOnly = true;
        else if (arg === '--source' || arg === '--denylist') {
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) parsed.error = arg + ' needs a path.';
            else parsed[arg.slice(2)] = argv[++i];
        } else if (arg.startsWith('-')) parsed.error = 'Unknown option: ' + arg;
        else parsed.paths.push(arg);
    }
    if (!parsed.error && parsed.source && parsed.paths.length > 0) {
        parsed.error = '--source is only used with no paths.';
    }
    if (!parsed.error && parsed.patternsOnly && parsed.denylist) {
        parsed.error = '--patterns-only checks without a denylist, so it cannot be used with --denylist.';
    }
    return parsed;
}

const USAGE = 'Usage: node scripts/public-content-check.mjs [--source <examples root>]   check what sync-to-hub.mjs would copy\n'
    + '       node scripts/public-content-check.mjs <file or directory>...       check these\n'
    + 'Options: --denylist <file>, or --patterns-only to skip the denylist terms.\n'
    + 'Exits 1 on any hit, 2 on a usage error.';

// Returns a promise of the process exit code.
async function main(argv, env, out, err, cwd) {
    const options = parseArgs(argv);
    if (options.help) {
        out(USAGE);
        return 0;
    }
    if (options.error) {
        err(options.error + '\n\n' + USAGE);
        return 2;
    }
    const here = cwd || process.cwd();
    let denylist;
    if (options.patternsOnly) {
        denylist = patternsOnlyDenylist();
        out('Pattern checks only: emails, phone numbers and AWS resources. No denylist terms were checked.');
    } else {
        try {
            denylist = loadDenylist(options.denylist ? path.resolve(here, options.denylist) : DENYLIST_PATH);
        } catch (error) {
            err(error.message);
            return 2;
        }
    }

    const files = [];
    if (options.paths.length === 0) {
        const { DEFAULT_SKILLS, listExtraFiles, listPlannedFiles } = await import('./sync-to-hub.mjs');
        const examples = options.source ? path.resolve(here, options.source) : EXAMPLES;
        if (!fs.existsSync(examples) || !fs.statSync(examples).isDirectory()) {
            err('No such directory: ' + examples);
            return 2;
        }
        const { planned } = listPlannedFiles({ examples: examples });
        for (const [rel, abs] of planned) files.push({ display: rel, abs: abs });
        const extra = listExtraFiles({ examples: examples, skills: options.source ? null : DEFAULT_SKILLS });
        for (const [rel, abs] of extra.planned) files.push({ display: rel, abs: abs });
        out('Checking the ' + files.length + ' files sync-to-hub.mjs would copy from ' + examples);
    } else {
        for (const given of options.paths) {
            const abs = path.resolve(here, given);
            if (!fs.existsSync(abs)) {
                err('No such file or directory: ' + given);
                return 2;
            }
            const list = fs.statSync(abs).isDirectory() ? walkFiles(abs) : [abs];
            for (const file of list) files.push({ display: displayName(file, here), abs: file });
        }
    }

    const result = scanFiles({ files: files, denylist: denylist });
    out(formatHits(result));
    return result.hits.length > 0 ? 1 : 0;
}

const runDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (runDirectly) {
    main(
        process.argv.slice(2),
        process.env,
        (text) => console.log(text),
        (text) => console.error(text)
    ).then((code) => {
        process.exitCode = code;
    }, (error) => {
        console.error(error && error.stack ? error.stack : String(error));
        process.exitCode = 2;
    });
}

export { DENYLIST_PATH, loadDenylist, patternsOnlyDenylist, termPattern, scanText, scanFiles, formatHits, formatHit, parseArgs, main };
