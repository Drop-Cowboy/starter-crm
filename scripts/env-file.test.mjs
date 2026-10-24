import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildEnv, keptSettings, parseEnv } from './lib/env-file.mjs';

const SITE = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d';

describe('parseEnv', () => {
    it('reads KEY=value lines and skips comments and blanks', () => {
        const values = parseEnv('# a comment\n\nDC_AUTH_MODE=server\nDROPCOWBOY_SITE_ID= ' + SITE + ' \r\nEMPTY=\n');
        assert.equal(values.get('DC_AUTH_MODE'), 'server');
        assert.equal(values.get('DROPCOWBOY_SITE_ID'), SITE);
        assert.equal(values.get('EMPTY'), '');
        assert.equal(values.has('# a comment'), false);
    });

    it('treats a missing file as empty', () => {
        assert.equal(parseEnv(undefined).size, 0);
    });
});

describe('keptSettings', () => {
    it('keeps the site id and the webhook secret', () => {
        const kept = keptSettings(parseEnv('DROPCOWBOY_SITE_ID=' + SITE + '\nDROPCOWBOY_WEBHOOK_SECRET=made-up-signing-secret\n'));
        assert.deepEqual(kept, { siteId: SITE, webhookSecret: 'made-up-signing-secret' });
    });

    it('drops a site id that is not a UUID, so setup generates one', () => {
        assert.equal(keptSettings(parseEnv('DROPCOWBOY_SITE_ID=replace-me\n')).siteId, '');
    });

    it('keeps nothing when there was no .env', () => {
        assert.deepEqual(keptSettings(null), { siteId: '', webhookSecret: '' });
    });
});

describe('buildEnv', () => {
    it('writes every setting, including a kept webhook secret, and reads back the same', () => {
        const text = buildEnv({ mode: 'server', siteId: SITE, apiKey: 'k', apiSecret: 's', userId: SITE, webhookSecret: 'made-up-signing-secret' });
        const values = parseEnv(text);
        assert.equal(values.get('DC_IDENTITY'), 'dev');
        assert.equal(values.get('DROPCOWBOY_SITE_ID'), SITE);
        assert.equal(values.get('DROPCOWBOY_WEBHOOK_SECRET'), 'made-up-signing-secret');
        assert.equal(values.get('PORT'), '8080');
        assert.ok(text.endsWith('\n'));
    });
});
