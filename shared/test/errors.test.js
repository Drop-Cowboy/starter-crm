import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AppError, errorFromResponse, explainError, explainPageError, readError, signInCode } from '../errors.js';
import { jsonResponse } from './helpers.js';

describe('readError', () => {
    it('reads the starter server envelope', () => {
        const err = readError(401, { error: { code: 'login_expired', message: 'Sign in again.' } });
        assert.equal(err.code, 'login_expired');
        assert.equal(err.message, 'Sign in again.');
        assert.equal(err.status, 401);
    });

    it('reads a problem+json body and normalizes kebab-case', () => {
        const err = readError(402, {
            type: 'https://docs.dropcowboy.com/errors/payment-required',
            title: 'Payment required',
            status: 402,
            detail: 'Add funds.'
        });
        assert.equal(err.code, 'payment_required');
        assert.equal(err.message, 'Add funds.');
    });

    it('prefers details.code over a generic problem type', () => {
        const err = readError(400, { type: 'https://docs.dropcowboy.com/errors/bad-request', details: { code: 'no_updatable_fields' } });
        assert.equal(err.code, 'no_updatable_fields');
    });

    it('reads the embed shape with a consent reason', () => {
        const err = readError(403, { message: 'Consent required', detail: { code: 'consent_required', reason: 'opted_out' } });
        assert.equal(err.code, 'consent_required');
        assert.equal(err.reason, 'opted_out');
    });

    it('reads an OAuth error body', () => {
        const err = readError(403, { error: 'invalid_grant', error_description: 'Invalid authorization code' });
        assert.equal(err.code, 'invalid_grant');
        assert.equal(err.message, 'Invalid authorization code');
    });

    it('falls back to the status when the body is empty', () => {
        assert.equal(readError(429, null).code, 'too_many_requests');
        assert.equal(readError(500, 'oops').code, 'request_failed');
    });

    it('keeps Retry-After from a response', async () => {
        const err = await errorFromResponse(jsonResponse(429, { error: { code: 'too_many_requests', message: '' } }, { 'Retry-After': '7' }));
        assert.equal(err.retryAfter, '7');
        assert.match(explainError(err).message, /Retry after 7 seconds/);
    });

    it('survives a body that is not JSON', async () => {
        const err = await errorFromResponse(new Response('<html>', { status: 502 }));
        assert.equal(err.code, 'request_failed');
        assert.equal(err.status, 502);
    });
});

describe('explainError', () => {
    it('explains each consent reason and points at the consent setting', () => {
        const g = explainError(new AppError('consent_required', '', { reason: 'no_granted_consent' }));
        assert.equal(g.title, 'Consent needed');
        assert.match(g.message, /no granted consent/);
        assert.match(g.message, /Use existing contact consent/);
        assert.equal(g.link.href, '/setup#contact_consent');
    });

    it('does not suggest the consent setting for an opt-out', () => {
        const g = explainError(new AppError('consent_required', '', { reason: 'opted_out' }));
        assert.match(g.message, /opted out/);
        assert.doesNotMatch(g.message, /Use existing contact consent/);
    });

    it('offers sign-in for login errors', () => {
        assert.equal(explainError(new AppError('login_required', '')).action, 'sign_in');
        assert.equal(explainError(new AppError('login_expired', '')).action, 'sign_in');
    });

    it('links setup gaps to their setup step', () => {
        assert.equal(explainError(new AppError('byoc_required', '')).link.href, '/setup#connect_byoc');
        assert.equal(explainError(new AppError('insufficient-balance', '')).link.href, '/setup#funds');
        assert.equal(explainError(new AppError('invalid_site_id', '')).link.href, '/setup#site_id');
    });

    it('accepts a widget dc-error detail', () => {
        const g = explainError({ code: 'consent_required', message: 'x', reason: 'contact_dnc' });
        assert.match(g.message, /Do Not Call/);
    });

    it('falls back to the message for unknown codes', () => {
        const g = explainError(new AppError('something_new', 'The server said no.'));
        assert.equal(g.title, 'Something went wrong');
        assert.equal(g.message, 'The server said no.');
    });

    it('handles values that are not errors', () => {
        assert.equal(explainError(undefined).code, 'request_failed');
        assert.equal(explainError('plain text').message, 'plain text');
    });
});

describe('explainPageError', () => {
    it('points at the banner for a refusal the banner already explains, and keeps the fix link', () => {
        const byoc = explainPageError(new AppError('byoc_required', ''));
        assert.equal(byoc.title, 'Calling and texting are off');
        assert.match(byoc.message, /until you connect your carrier/);
        assert.match(byoc.message, /notice at the top of the page/);
        assert.equal(byoc.link.href, '/setup#connect_byoc');

        const funds = explainPageError(new AppError('insufficient-balance', ''));
        assert.match(funds.message, /until you add funds/);
        assert.equal(funds.link.href, '/setup#funds');
    });

    it('explains everything else in full', () => {
        const err = new AppError('consent_required', '', { reason: 'opted_out' });
        assert.deepEqual(explainPageError(err), explainError(err));
        assert.deepEqual(explainPageError({ code: 'business_number_missing' }), explainError({ code: 'business_number_missing' }));
    });
});

describe('guidance for your own server\'s identity', () => {
    it('explains each identity code in plain language, with no raw code as the title', () => {
        for (const code of ['unauthenticated', 'invalid_passcode', 'invalid_token', 'identity_unavailable', 'rate_limited', 'csrf_rejected']) {
            const g = explainError(new AppError(code, 'raw server text'));
            assert.notEqual(g.title, code);
            assert.doesNotMatch(g.message, /raw server text/);
        }
    });

    it('picks login guidance only when login mode is on', () => {
        assert.equal(signInCode({ login: null }), 'unauthenticated');
        assert.equal(signInCode({ login: { isConfigured: () => true } }), 'login_required');
        assert.equal(signInCode({ login: { isConfigured: () => false } }), 'login_not_configured');
    });
});
