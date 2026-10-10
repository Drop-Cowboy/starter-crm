import { describe, expect, it } from 'vitest';
import { createLogger, redact } from '../src/log.js';
import { API_KEY, API_SECRET, WEBHOOK_SECRET, makeConfig } from './helpers.js';

describe('redact', () => {
    it('removes configured secrets wherever they appear', () => {
        const line = redact('x-key=' + API_KEY + ' x-secret=' + API_SECRET + API_SECRET, [API_KEY, API_SECRET]);
        expect(line).toBe('x-key=[redacted] x-secret=[redacted][redacted]');
    });

    it('removes anything shaped like a JWT', () => {
        expect(redact('token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln done', [])).toBe('token [redacted-token] done');
    });

    it('removes bearer credentials that are not JWTs', () => {
        expect(redact('authorization: bearer opaque.Access-Token~1== sent', [])).toBe('authorization: Bearer [redacted] sent');
    });
});

describe('createLogger', () => {
    it('scrubs secrets from strings, objects and errors', () => {
        const lines = [];
        const sink = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
        const second = 'second-subscription-secret';
        const log = createLogger(makeConfig({ DROPCOWBOY_WEBHOOK_SECRET: WEBHOOK_SECRET + ',' + second }), sink);

        log.info('headers', { 'x-key': API_KEY, 'x-secret': API_SECRET });
        log.warn('secrets are', WEBHOOK_SECRET, second);
        log.error(new Error('failed with ' + API_SECRET));

        const all = lines.join('\n');
        for (const secret of [API_KEY, API_SECRET, WEBHOOK_SECRET, second]) {
            expect(all).not.toContain(secret);
        }
        expect(lines).toHaveLength(3);
    });
});
