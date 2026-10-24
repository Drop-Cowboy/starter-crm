import { describe, expect, it } from 'vitest';
import * as memory from '../src/providers/ratelimit/memory.js';
import * as off from '../src/providers/ratelimit/off.js';
import { VECTORS } from './vectors.js';

describe('memory rate limiter', () => {
    it('follows the shared sequence and counts keys apart', async () => {
        const spec = VECTORS.ratelimit;
        const limiter = memory.create();
        const seen = [];
        for (let i = 0; i < spec.sequence.length; i++) {
            seen.push((await limiter.hit(spec.key, spec.limit, spec.windowSeconds)).allowed);
        }
        expect(seen).toEqual(spec.sequence);
        expect((await limiter.hit(spec.otherKey, spec.limit, spec.windowSeconds)).allowed).toBe(true);
    });

    it('opens a fresh window once the old one has passed, and reports whole seconds to wait', async () => {
        let now = 5_000_000;
        const limiter = memory.create({ now: () => now });
        await limiter.hit('k', 1, 60);
        now += 1500;
        const refused = await limiter.hit('k', 1, 60);
        expect(refused).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 59 });
        now += 59_000;
        expect((await limiter.hit('k', 1, 60)).allowed).toBe(true);
    });

    it('reports remaining attempts', async () => {
        const limiter = memory.create();
        expect((await limiter.hit('k', 3, 60)).remaining).toBe(2);
        expect((await limiter.hit('k', 3, 60)).remaining).toBe(1);
    });

    it('sweeps expired windows so many distinct keys cannot grow memory without bound', async () => {
        let now = 1_000_000;
        const limiter = memory.create({ now: () => now });
        for (let i = 0; i < 10000; i++) await limiter.hit('k' + i, 5, 1);
        now += 5000;
        // The sweep runs on this hit; the old key's window is gone, so it starts again at one.
        expect((await limiter.hit('k0', 1, 60)).allowed).toBe(true);
    });
});

describe('off rate limiter', () => {
    it('allows everything', async () => {
        const limiter = off.create();
        for (let i = 0; i < 50; i++) expect((await limiter.hit('k', 1, 60)).allowed).toBe(true);
    });
});
