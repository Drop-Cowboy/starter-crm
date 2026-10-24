import { useState } from 'react';
import { signInScreen } from '@shared/identity.js';

/**
 * The screen shown instead of the CRM when your own server says nobody is
 * signed in (server mode). With the passcode identity it is a one-field form;
 * with any other identity it explains where the sign-in happens.
 *
 * @param {{ crm: { identity: ReturnType<typeof import('@shared/identity.js').createIdentity> } }} props
 */
export function SignIn({ crm }) {
    const screen = signInScreen(crm.identity.current());
    const [passcode, setPasscode] = useState('');
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState('');

    async function submit(event) {
        event.preventDefault();
        setBusy(true);
        setProblem('');
        try {
            await crm.identity.signInWithPasscode(passcode);
            window.location.reload();
        } catch (err) {
            setProblem(err && err.message ? err.message : 'Sign-in failed.');
            setBusy(false);
        }
    }

    return (
        <main className="signin" id="main" tabIndex={-1}>
            <div className="signin-card">
                <h1>{screen.title}</h1>
                <p>{screen.message}</p>
                {screen.form && (
                    <form className="signin-form" onSubmit={submit}>
                        <div className="field">
                            <label htmlFor="passcode">Passcode</label>
                            <input
                                id="passcode"
                                name="passcode"
                                type="password"
                                autoComplete="current-password"
                                required
                                aria-describedby="passcode-status"
                                value={passcode}
                                onChange={(event) => setPasscode(event.target.value)}
                            />
                        </div>
                        <button className="btn primary" type="submit" disabled={busy}>Sign in</button>
                        <p className="signin-status" id="passcode-status" role="alert">{problem}</p>
                    </form>
                )}
            </div>
        </main>
    );
}
