import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { parseArgs, scaffold, singularOf } from './new-module.mjs';

const roots = [];
function tempRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'new-module-'));
    roots.push(root);
    return root;
}
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('singularOf', () => {
    it('reads plurals', () => {
        assert.equal(singularOf('tickets'), 'ticket');
        assert.equal(singularOf('categories'), 'category');
        assert.equal(singularOf('support-tickets'), 'support-ticket');
    });

    it('gives up on what does not look plural', () => {
        assert.equal(singularOf('staff'), null);
        assert.equal(singularOf('address'), null);
        assert.equal(singularOf('s'), null);
    });
});

describe('parseArgs', () => {
    it('takes an id and an optional --singular', () => {
        assert.deepEqual(parseArgs(['tickets']), { id: 'tickets' });
        assert.deepEqual(parseArgs(['staff', '--singular', 'staff-member']), { id: 'staff', singular: 'staff-member' });
        assert.deepEqual(parseArgs(['--singular=x', 'xs']), { id: 'xs', singular: 'x' });
    });

    it('refuses anything else', () => {
        assert.throws(() => parseArgs(['a', 'b']), /Unexpected argument "b"/);
        assert.throws(() => parseArgs(['--force']), /Unexpected argument/);
    });
});

describe('scaffold', () => {
    it('writes the Node module, the Python module and the schema', () => {
        const root = tempRoot();
        const result = scaffold({ root, id: 'support-tickets' });
        assert.deepEqual(result.files, [
            path.join('server', 'node', 'src', 'modules', 'support-tickets', 'index.js'),
            path.join('server', 'python', 'starter_crm', 'modules', 'support_tickets.py'),
            path.join('server', 'schemas', 'support-tickets.json')
        ]);
        const node = fs.readFileSync(path.join(root, result.files[0]), 'utf8');
        const python = fs.readFileSync(path.join(root, result.files[1]), 'utf8');
        const schema = fs.readFileSync(path.join(root, result.files[2]), 'utf8');
        for (const text of [node, python, schema]) {
            assert.doesNotMatch(text, /__[A-Z_]+__/, 'a placeholder was left behind');
        }
        assert.match(node, /id: 'support-tickets'/);
        assert.match(node, /const COLLECTION = 'support_tickets'/);
        assert.match(node, /'support_ticket_not_found'/);
        assert.match(node, /loadSchemas\('support-tickets'\)/);
        assert.match(python, /MODULE = Module\(id="support-tickets"/);
        assert.match(python, /COLLECTION = "support_tickets"/);
        assert.match(python, /load_schemas\("support-tickets"\)/);
        assert.ok(JSON.parse(schema).create.required.includes('title'));
    });

    it('writes JavaScript and Python that parse', () => {
        const root = tempRoot();
        const result = scaffold({ root, id: 'tickets' });
        const node = spawnSync(process.execPath, ['--check', path.join(root, result.files[0])], { encoding: 'utf8' });
        assert.equal(node.status, 0, node.stderr);
        const python = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read())', path.join(root, result.files[1])], { encoding: 'utf8' });
        if (!python.error) assert.equal(python.status, 0, python.stderr);
    });

    it('takes a singular for a name it cannot read', () => {
        const root = tempRoot();
        assert.throws(() => scaffold({ root, id: 'staff-list' }), /Say it: npm run new:module -- staff-list --singular/);
        const result = scaffold({ root, id: 'staff', singular: 'staff-member' });
        assert.match(fs.readFileSync(path.join(root, result.files[0]), 'utf8'), /'staff_member_not_found'/);
    });

    it('refuses a bad id, a reserved id and a bad singular', () => {
        const root = tempRoot();
        for (const id of ['Tickets', '1up', 'a_b', 'x'.repeat(40), 'tickets-', '', undefined]) {
            assert.throws(() => scaffold({ root, id }), /A module id is lowercase letters/);
        }
        assert.throws(() => scaffold({ root, id: 'add' }), /already used by the app/);
        assert.throws(() => scaffold({ root, id: 'tickets', singular: 'Ticket' }), /--singular is lowercase/);
        assert.deepEqual(fs.readdirSync(root), []);
    });

    it('never overwrites, and writes nothing when one file is in the way', () => {
        const root = tempRoot();
        scaffold({ root, id: 'tickets' });
        assert.throws(() => scaffold({ root, id: 'tickets' }), /already exists. Nothing was written/);

        const other = tempRoot();
        const schema = path.join(other, 'server', 'schemas', 'tickets.json');
        fs.mkdirSync(path.dirname(schema), { recursive: true });
        fs.writeFileSync(schema, '{}');
        assert.throws(() => scaffold({ root: other, id: 'tickets' }), /tickets.json already exists/);
        assert.equal(fs.existsSync(path.join(other, 'server', 'node')), false);
        assert.equal(fs.readFileSync(schema, 'utf8'), '{}');
    });
});
