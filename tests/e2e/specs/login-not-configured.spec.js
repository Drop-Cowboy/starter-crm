import { expectAccessible } from '../support/a11y.js';
import { test, expect } from '../support/test.js';

// login mode before AUTH0_CLIENT_ID is set: the app must say what is missing.

test.use({ serverMode: 'login-not-configured' });

test.describe('login mode without AUTH0_CLIENT_ID', () => {
    test('explains how to set up sign-in', async ({ page, app, dropcowboy }) => {
        await app.goto('/setup');

        await expect(page.getByRole('heading', { name: 'How this app signs in: login' })).toBeVisible();
        await expect(page.getByText('Sign-in not set up', { exact: true })).toBeVisible();
        await expect(page.getByRole('main')).toContainText('Sign-in is not set up yet');
        await expect(page.getByRole('button', { name: 'Sign in with Drop Cowboy' })).toHaveCount(0);
        expect(dropcowboy.mints).toEqual([]);
        await expectAccessible(page);
    });
});
