import { describe, expect, it } from 'vitest';
import { HOOK_NAMES, createHooks } from '../src/hooks.js';

describe('createHooks', () => {
    it('is a no-op without an observer', async () => {
        const hooks = createHooks(null, { warn: async () => {} });
        for (const name of HOOK_NAMES) await expect(hooks[name]({})).resolves.toBeUndefined();
    });

    it('awaits an async hook before resolving', async () => {
        const order = [];
        const hooks = createHooks({
            onRequest: async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                order.push('hook');
            }
        }, { warn: async () => {} });
        await hooks.onRequest({});
        order.push('after');
        expect(order).toEqual(['hook', 'after']);
    });

    it('catches a throwing hook and logs a warning, without printing the payload', async () => {
        const warnings = [];
        const hooks = createHooks({
            onWebhook() {
                throw new Error('monitoring is down');
            }
        }, { warn: async (text) => warnings.push(text) });
        await expect(hooks.onWebhook({ secret: 'payload' })).resolves.toBeUndefined();
        expect(warnings).toEqual(['Observer hook onWebhook failed: monitoring is down']);
    });

    it('skips hooks the observer does not implement', async () => {
        const seen = [];
        const hooks = createHooks({ onError: (payload) => seen.push(payload.message) }, { warn: async () => {} });
        await hooks.onRequest({});
        await hooks.onError({ message: 'boom' });
        expect(seen).toEqual(['boom']);
    });
});
