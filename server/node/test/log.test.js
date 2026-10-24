import { describe, expect, it } from 'vitest';
import { createLogger, redact } from '../src/log.js';
import { API_KEY, API_SECRET, WEBHOOK_SECRET, makeConfig } from './helpers.js';
import { VECTORS } from './vectors.js';

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

describe('redact (shared vectors)', () => {
    for (const vector of VECTORS.redaction) {
        it('handles: ' + vector.input, () => {
            expect(redact(vector.input, vector.secrets)).toBe(vector.expect);
        });
    }
});

describe('createLogger', () => {
    it('scrubs secrets from strings, objects and errors', async () => {
        const lines = [];
        const sink = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
        const second = 'second-subscription-secret';
        const log = createLogger(makeConfig({ DROPCOWBOY_WEBHOOK_SECRET: WEBHOOK_SECRET + ',' + second }), sink);

        await log.info('headers', { 'x-key': API_KEY, 'x-secret': API_SECRET });
        await log.warn('secrets are', WEBHOOK_SECRET, second);
        await log.error(new Error('failed with ' + API_SECRET));

        const all = lines.join('\n');
        for (const secret of [API_KEY, API_SECRET, WEBHOOK_SECRET, second]) {
            expect(all).not.toContain(secret);
        }
        expect(lines).toHaveLength(3);
    });

    it('hands a provider sink the redacted record with request id, level and fields', async () => {
        const records = [];
        const log = createLogger(makeConfig(), { write: (record) => records.push(record) }).child({ request_id: 'req-1', token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln' });
        await log.info('saw jane@example.com at +13125550142');
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
            level: 'info',
            request_id: 'req-1',
            message: 'saw [redacted-email] at [redacted-phone]',
            token: '[redacted-token]'
        });
        expect(typeof records[0].time).toBe('string');
    });

    it('writes JSON lines to a console sink when the format is json', async () => {
        const lines = [];
        const sink = { log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l) };
        const log = createLogger(makeConfig({ DC_LOG_FORMAT: 'json' }), sink);
        await log.access({ method: 'GET', path: '/healthz', status: 200, duration_ms: 2 });
        expect(JSON.parse(lines[0])).toMatchObject({ level: 'info', method: 'GET', path: '/healthz', status: 200, duration_ms: 2 });
    });

    it('survives a sink that throws', async () => {
        const log = createLogger(makeConfig(), { write() { throw new Error('disk full'); } });
        await expect(log.info('still fine')).resolves.toBeUndefined();
    });

    it('covers secrets a provider loaded after the logger was built', async () => {
        const records = [];
        const config = makeConfig();
        const log = createLogger(config, { write: (record) => records.push(record) });
        config.knownSecrets = new Set(['rotated-secret-7788']);
        await log.info('value rotated-secret-7788');
        expect(records[0].message).toBe('value [redacted]');
    });
});
