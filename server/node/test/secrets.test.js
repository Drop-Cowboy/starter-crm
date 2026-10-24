import { describe, expect, it } from 'vitest';
import { applySecrets, createSecretsRuntime } from '../src/secrets.js';
import { makeConfig } from './helpers.js';

describe('applySecrets', () => {
    it('swaps the API key, secret and webhook secrets, and remembers every value for redaction', () => {
        const config = makeConfig();
        applySecrets(config, {
            DROPCOWBOY_API_KEY: ' new-key-9999 ',
            DROPCOWBOY_API_SECRET: 'new-secret-9999',
            DROPCOWBOY_WEBHOOK_SECRET: 'wh-one-9999, wh-two-9999'
        });
        expect(config.apiKey).toBe('new-key-9999');
        expect(config.apiSecret).toBe('new-secret-9999');
        expect(config.webhookSecrets).toEqual(['wh-one-9999', 'wh-two-9999']);
        expect(config.knownSecrets.has('new-secret-9999')).toBe(true);
    });

    it('leaves a value alone when the provider returns it empty', () => {
        const config = makeConfig();
        const before = config.apiKey;
        applySecrets(config, { DROPCOWBOY_API_KEY: '   ' });
        expect(config.apiKey).toBe(before);
    });
});

describe('createSecretsRuntime', () => {
    function setup(refresh, intervalSeconds = 300) {
        let now = 1_000_000;
        const config = makeConfig();
        const warnings = [];
        const runtime = createSecretsRuntime({
            config,
            instance: { refresh },
            log: { warn: async (text) => warnings.push(text) },
            intervalSeconds,
            now: () => now
        });
        return { config, warnings, runtime, advance: (seconds) => { now += seconds * 1000; } };
    }

    it('does nothing before the interval has passed, then refreshes once', async () => {
        let calls = 0;
        const { config, runtime, advance } = setup(async () => {
            calls++;
            return { DROPCOWBOY_API_KEY: 'rotated-key-0009' };
        });
        await runtime.refreshIfDue();
        expect(calls).toBe(0);
        advance(301);
        await runtime.refreshIfDue();
        await runtime.refreshIfDue();
        expect(calls).toBe(1);
        expect(config.apiKey).toBe('rotated-key-0009');
    });

    it('keeps the last good values and warns when a refresh fails', async () => {
        const { config, warnings, runtime, advance } = setup(async () => {
            throw new Error('vault unreachable');
        });
        const before = config.apiKey;
        advance(301);
        await runtime.refreshIfDue();
        expect(config.apiKey).toBe(before);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('keeping the last good values');
    });

    it('never refreshes when the interval is 0', async () => {
        let calls = 0;
        const { runtime, advance } = setup(async () => {
            calls++;
            return {};
        }, 0);
        advance(100000);
        await runtime.refreshIfDue();
        expect(calls).toBe(0);
    });

    it('shares one refresh among concurrent requests', async () => {
        let calls = 0;
        const { runtime, advance } = setup(async () => {
            calls++;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return {};
        });
        advance(301);
        await Promise.all([runtime.refreshIfDue(), runtime.refreshIfDue(), runtime.refreshIfDue()]);
        expect(calls).toBe(1);
    });
});
