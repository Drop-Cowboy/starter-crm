import { describe, expect, it } from 'vitest';
import { CACHE_MARGIN_MS, createTokenCache } from '../src/token-cache.js';

describe('createTokenCache', () => {
    it('serves a token while more than 60 seconds remain', () => {
        let now = 1_000_000;
        const cache = createTokenCache(() => now);
        cache.set('u|crm', { token: 'abc', expires_at: now + CACHE_MARGIN_MS + 1000 });
        expect(cache.get('u|crm').token).toBe('abc');
        now += 999;
        expect(cache.get('u|crm').token).toBe('abc');
        now += 1;
        expect(cache.get('u|crm')).toBeNull();
    });

    it('does not store a token already inside the margin', () => {
        const now = 1_000_000;
        const cache = createTokenCache(() => now);
        cache.set('u|crm', { token: 'abc', expires_at: now + CACHE_MARGIN_MS });
        expect(cache.get('u|crm')).toBeNull();
    });

    it('keeps users and purposes apart', () => {
        const now = 1_000_000;
        const cache = createTokenCache(() => now);
        cache.set('a|x', { token: 'one', expires_at: now + 3_600_000 });
        expect(cache.get('a|y')).toBeNull();
        expect(cache.get('b|x')).toBeNull();
    });

    it('drops the oldest entries past 1000', () => {
        const now = 1_000_000;
        const cache = createTokenCache(() => now);
        for (let i = 0; i < 1001; i++) cache.set('k' + i, { token: 't' + i, expires_at: now + 3_600_000 });
        expect(cache.get('k0')).toBeNull();
        expect(cache.get('k1').token).toBe('t1');
        expect(cache.get('k1000').token).toBe('t1000');
    });
});
