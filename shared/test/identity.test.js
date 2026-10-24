import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createIdentity, signInScreen } from '../identity.js';
import { getAuthHeader, hasAuthHeaderProvider, callServer, setAuthHeaderProvider } from '../server-api.js';
import { header, jsonResponse, scriptedFetch } from './helpers.js';

const OWNER = { id: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' };

describe('createIdentity', () => {
    it('reads who the user is from GET /api/auth/session', async () => {
        const fetch = scriptedFetch([() => jsonResponse(200, { identity: 'passcode', signed_in: false, user: null })]);
        const session = await createIdentity({ fetch }).session();
        assert.deepEqual(session, { identity: 'passcode', signedIn: false, user: null });
        assert.equal(fetch.calls[0].url, '/api/auth/session');
    });

    it('treats a server without the route as the dev identity, which needs no sign-in', async () => {
        const fetch = scriptedFetch([() => jsonResponse(404, { error: { code: 'not_found', message: 'No route.' } })]);
        const session = await createIdentity({ fetch }).session();
        assert.equal(session.identity, 'dev');
        assert.equal(session.signedIn, true);
    });

    it('lets any other failure through', async () => {
        const fetch = scriptedFetch([() => jsonResponse(503, { error: { code: 'identity_unavailable', message: 'Down.' } })]);
        await assert.rejects(createIdentity({ fetch }).session(), { code: 'identity_unavailable' });
    });

    it('signs in with the passcode as JSON, then asks the server who it is now', async () => {
        const fetch = scriptedFetch([
            () => jsonResponse(200, { signed_in: true }),
            () => jsonResponse(200, { identity: 'passcode', signed_in: true, user: OWNER })
        ]);
        const identity = createIdentity({ fetch });
        const session = await identity.signInWithPasscode('a-long-enough-passcode');
        assert.equal(fetch.calls[0].url, '/api/auth/passcode');
        assert.equal(fetch.calls[0].init.method, 'POST');
        assert.equal(header(fetch.calls[0].init, 'content-type'), 'application/json');
        assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { passcode: 'a-long-enough-passcode' });
        assert.equal(session.signedIn, true);
        assert.equal(identity.current().user.id, OWNER.id);
    });

    it('shows the server\'s refusal of a wrong passcode', async () => {
        const fetch = scriptedFetch([() => jsonResponse(401, { error: { code: 'invalid_passcode', message: 'That passcode is not right.' } })]);
        await assert.rejects(createIdentity({ fetch }).signInWithPasscode('wrong-passcode-here'), { code: 'invalid_passcode' });
    });

    it('does not call the server for an empty passcode', async () => {
        const fetch = scriptedFetch([]);
        await assert.rejects(createIdentity({ fetch }).signInWithPasscode(''), { code: 'invalid_passcode' });
        assert.equal(fetch.calls.length, 0);
    });

    it('signs out and re-reads the session', async () => {
        const fetch = scriptedFetch([
            () => jsonResponse(200, { signed_in: false }),
            () => jsonResponse(200, { identity: 'passcode', signed_in: false, user: null })
        ]);
        const session = await createIdentity({ fetch }).signOut();
        assert.equal(fetch.calls[0].url, '/api/auth/signout');
        assert.equal(session.signedIn, false);
    });
});

describe('signInScreen', () => {
    it('is a form only for the passcode identity', () => {
        assert.equal(signInScreen({ identity: 'passcode' }).form, true);
        assert.equal(signInScreen({ identity: 'oidc' }).form, false);
        assert.match(signInScreen({ identity: 'oidc' }).message, /setAuthHeaderProvider/);
        assert.match(signInScreen({ identity: 'custom' }).message, /DC_IDENTITY=custom/);
    });
});

describe('the auth header provider', () => {
    it('adds the identity header to every call, and an explicit header wins', async () => {
        setAuthHeaderProvider(async () => ({ Authorization: 'Bearer from-provider', 'X-Other': 'kept' }));
        try {
            assert.equal(hasAuthHeaderProvider(), true);
            const fetch = scriptedFetch([() => jsonResponse(200, {}), () => jsonResponse(200, {})]);
            await callServer('/api/contacts-ish', { fetch });
            await callServer('/api/contacts-ish', { fetch, headers: { Authorization: 'Bearer explicit' } });
            assert.equal(header(fetch.calls[0].init, 'authorization'), 'Bearer from-provider');
            assert.equal(header(fetch.calls[0].init, 'x-other'), 'kept');
            assert.equal(header(fetch.calls[1].init, 'authorization'), 'Bearer explicit');
        } finally {
            setAuthHeaderProvider(null);
        }
        assert.equal(hasAuthHeaderProvider(), false);
        assert.deepEqual(await getAuthHeader(), {});
    });

    it('still reaches the server when the provider has no token yet', async () => {
        setAuthHeaderProvider(() => null);
        try {
            const fetch = scriptedFetch([() => jsonResponse(200, {})]);
            await callServer('/api/x', { fetch });
            assert.equal(header(fetch.calls[0].init, 'authorization'), undefined);
        } finally {
            setAuthHeaderProvider(null);
        }
    });
});
