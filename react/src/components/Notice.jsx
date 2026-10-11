import { Link } from 'react-router';
import { explainError, explainPageError } from '@shared/errors.js';
import { useCrm } from '../crm-context.js';
import { useAppPath } from '../layout-context.js';

function FixLink({ link }) {
    const appPath = useAppPath();
    // Fixes inside this app (/setup#funds) go through the router, so they
    // keep the /react base path. Anything else is Drop Cowboy itself.
    if (link.href.startsWith('/')) {
        return <Link to={appPath(link.href)}>{link.label}</Link>;
    }
    return <a href={link.href} target="_blank" rel="noopener">{link.label} (opens Drop Cowboy)</a>;
}

/**
 * A plain-language explanation of an error, with the fix link and a
 * "Sign in" button when signing in is the fix. Inside a page it is short for
 * a refusal the app banner already explains; set `full` for the banner
 * itself, or where there is no banner.
 * @param {{ error: unknown, full?: boolean }} props
 */
export function ErrorNotice({ error, full }) {
    const crm = useCrm();
    const g = full ? explainError(error) : explainPageError(error);
    const canSignIn = g.action === 'sign_in' && crm && crm.login && crm.login.isConfigured();
    return (
        <div className="notice error" role="alert">
            <h2>{g.title}</h2>
            <p>{g.message}</p>
            {(canSignIn || g.link) && (
                <div className="actions">
                    {canSignIn && (
                        <button type="button" className="btn primary" onClick={() => crm.login.signIn(window.location.pathname)}>
                            Sign in with Drop Cowboy
                        </button>
                    )}
                    {g.link && <FixLink link={g.link} />}
                </div>
            )}
        </div>
    );
}

export function InfoNotice({ title, children }) {
    return (
        <div className="notice info">
            <h2>{title}</h2>
            <p>{children}</p>
        </div>
    );
}

export function Loading({ label }) {
    return <p className="hint" role="status">{label || 'Loading…'}</p>;
}
