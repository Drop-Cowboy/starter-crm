import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSseParser, memoryGrowth, percentile, verdict } from './lib/soak-stats.mjs';

describe('percentile', () => {
    it('uses the nearest rank', () => {
        const values = Array.from({ length: 100 }, (_, i) => i + 1);
        assert.equal(percentile(values, 50), 50);
        assert.equal(percentile(values, 99), 99);
        assert.equal(percentile(values, 100), 100);
        assert.equal(percentile([5], 99), 5);
        assert.equal(percentile([], 99), 0);
    });

    it('does not depend on the order or change its input', () => {
        const values = [9, 1, 5];
        assert.equal(percentile(values, 50), 5);
        assert.deepEqual(values, [9, 1, 5]);
    });
});

describe('memoryGrowth', () => {
    const series = (rss) => rss.map((rssMb, i) => ({ at: i * 1000, rssMb }));

    it('needs enough settled samples to judge', () => {
        assert.equal(memoryGrowth(series([100, 100, 100]), 0).enough, false);
        assert.equal(memoryGrowth(series(Array(10).fill(100)), 9000).enough, false);
    });

    it('calls a steady server steady, and ignores the warm-up', () => {
        const result = memoryGrowth(series([50, 80, 120, 121, 120, 122, 121, 120, 122, 121, 120, 121]), 3000);
        assert.equal(result.enough, true);
        assert.equal(result.grew, false);
    });

    it('calls a climbing server a leak', () => {
        const result = memoryGrowth(series([100, 110, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300]), 0);
        assert.equal(result.grew, true);
        assert.ok(result.growthMb > 100);
    });

    it('needs both the absolute and the relative growth', () => {
        assert.equal(memoryGrowth(series([1000, 1000, 1000, 1000, 1010, 1040, 1040, 1040, 1040, 1040, 1040, 1040]), 0).grew, false);
        assert.equal(memoryGrowth(series([10, 10, 10, 10, 10, 10, 20, 20, 20, 20, 20, 20]), 0).grew, false);
    });
});

describe('createSseParser', () => {
    it('reads messages split across chunks, comments and named events', () => {
        const parser = createSseParser();
        assert.deepEqual(parser.push(': keepalive\n\nid: a1\nda'), []);
        assert.deepEqual(parser.push('ta: {"x":1}\n\nevent: replayed\ndata: {}\n\n'), [
            { id: 'a1', event: 'message', data: '{"x":1}' },
            { id: null, event: 'replayed', data: '{}' }
        ]);
    });

    it('joins multi-line data', () => {
        assert.deepEqual(createSseParser().push('data: one\ndata: two\n\n'), [{ id: null, event: 'message', data: 'one\ntwo' }]);
    });
});

describe('verdict', () => {
    const GOOD = {
        ackMs: [10, 12, 15, 20, 900], posted: 5, failed: 0, expectedDeliveries: 2500, delivered: 2500, streamsLost: 0,
        memory: { grew: false, enough: true, startMb: 100, endMb: 105 }
    };

    it('passes a healthy run', () => {
        const result = verdict(GOOD);
        assert.equal(result.ok, true);
        assert.deepEqual(result.problems, []);
    });

    it('names each way a run can fail', () => {
        const result = verdict({
            ...GOOD, ackMs: [10, 2500], failed: 1, delivered: 2000, streamsLost: 3,
            memory: { grew: true, enough: true, startMb: 100, endMb: 400 }
        });
        assert.equal(result.ok, false);
        assert.equal(result.problems.length, 5);
        assert.match(result.problems.join('\n'), /p99 acknowledgement was 2500 ms/);
        assert.match(result.problems.join('\n'), /memory grew from 100 MB to 400 MB/);
    });

    it('fails a run that sent nothing', () => {
        assert.equal(verdict({ ...GOOD, ackMs: [], posted: 0 }).ok, false);
    });
});
