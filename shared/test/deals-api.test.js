import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { archivedNote, createDealsApi, dealsAvailable, formatAmount, parseAmount, stageLabel } from '../deals-api.js';

function recorder(answer) {
    const calls = [];
    const call = async (path, options) => {
        calls.push({ path, options });
        return answer;
    };
    call.calls = calls;
    return call;
}

describe('deals API', () => {
    it('lists with no filter, and with filters as a query string', async () => {
        const call = recorder({ deals: [] });
        const api = createDealsApi({ call });
        assert.deepEqual(await api.list(), []);
        await api.list({ stage: 'won', archived: false, contactId: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d' });
        await api.list({ archived: 'all' });
        assert.equal(call.calls[2].path, '/api/modules/deals?archived=all');
        assert.equal(call.calls[0].path, '/api/modules/deals');
        assert.equal(call.calls[1].path, '/api/modules/deals?stage=won&contact_id=5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d&archived=false');
    });

    it('creates and updates with POST, and deletes with DELETE', async () => {
        const call = recorder({ deal: { id: 'd1' } });
        const api = createDealsApi({ call });
        assert.deepEqual(await api.create({ title: 'x' }), { id: 'd1' });
        await api.update('a b', { stage: 'won' });
        await api.remove('d1');
        assert.deepEqual(call.calls[0], { path: '/api/modules/deals', options: { method: 'POST', body: { title: 'x' } } });
        assert.deepEqual(call.calls[1], { path: '/api/modules/deals/a%20b', options: { method: 'POST', body: { stage: 'won' } } });
        assert.deepEqual(call.calls[2], { path: '/api/modules/deals/d1', options: { method: 'DELETE' } });
    });
});

describe('deals helpers', () => {
    it('runs modules only in server mode', () => {
        assert.equal(dealsAvailable({ auth_mode: 'server' }), true);
        assert.equal(dealsAvailable({ auth_mode: 'login' }), false);
        assert.equal(dealsAvailable({ auth_mode: 'mcp-session' }), false);
        assert.equal(dealsAvailable(null), false);
    });

    it('parses amounts into cents', () => {
        assert.equal(parseAmount(''), 0);
        assert.equal(parseAmount('12'), 1200);
        assert.equal(parseAmount('12.5'), 1250);
        assert.equal(parseAmount('1,250.05'), 125005);
        assert.equal(parseAmount('-1'), null);
        assert.equal(parseAmount('1.234'), null);
        assert.equal(parseAmount('abc'), null);
    });

    it('formats amounts, stages and archive notes', () => {
        assert.match(formatAmount(125000, 'USD'), /1,250\.00/);
        assert.equal(stageLabel('proposal'), 'Proposal');
        assert.equal(stageLabel('custom'), 'custom');
        assert.equal(archivedNote({ archived: false }), '');
        assert.equal(archivedNote({ archived: true, archived_reason: 'manual' }), 'Archived');
        assert.match(archivedNote({ archived: true, archived_reason: 'contact_deleted' }), /contact was deleted/);
    });
});
