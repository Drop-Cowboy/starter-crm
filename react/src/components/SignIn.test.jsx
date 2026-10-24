import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@shared/errors.js';
import { SignIn } from './SignIn.jsx';
import { renderApp, fakeCrm } from '../test/render.jsx';

function crmFor(identity, signInWithPasscode) {
    return {
        identity: {
            current: () => ({ identity, signedIn: false, user: null }),
            signInWithPasscode: signInWithPasscode || vi.fn()
        }
    };
}

afterEach(cleanup);

describe('sign-in screen', () => {
    it('is a passcode form for the passcode identity', () => {
        render(<SignIn crm={crmFor('passcode')} />);
        expect(screen.getByRole('heading', { name: 'Sign in to Starter CRM', level: 1 })).toBeTruthy();
        expect(screen.getByLabelText('Passcode').getAttribute('type')).toBe('password');
    });

    it('shows the server\'s refusal and lets the person try again', async () => {
        const signIn = vi.fn().mockRejectedValue(new AppError('invalid_passcode', 'That passcode is not right.'));
        render(<SignIn crm={crmFor('passcode', signIn)} />);
        fireEvent.change(screen.getByLabelText('Passcode'), { target: { value: 'wrong-passcode-here' } });
        fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('That passcode is not right.'));
        expect(signIn).toHaveBeenCalledWith('wrong-passcode-here');
        expect(screen.getByRole('button', { name: 'Sign in' }).disabled).toBe(false);
    });

    it('only explains the sign-in for an identity the page cannot sign in itself', () => {
        render(<SignIn crm={crmFor('oidc')} />);
        expect(screen.getByRole('heading', { name: 'Sign in with your account' })).toBeTruthy();
        expect(screen.queryByLabelText('Passcode')).toBeNull();
        expect(document.body.textContent).toContain('setAuthHeaderProvider');
    });
});

describe('sign out', () => {
    it('is offered in the top bar to a passcode user, and not to the dev identity', () => {
        const passcode = fakeCrm({
            identity: { current: () => ({ identity: 'passcode', signedIn: true, user: null }), signOut: vi.fn() }
        });
        renderApp({ crm: passcode, path: '/pipeline' });
        expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
        cleanup();
        renderApp({ crm: fakeCrm(), path: '/pipeline' });
        expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    });
});
