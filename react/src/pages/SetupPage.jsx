import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { cdnVersionFor } from '@shared/config.js';
import { getBusinessNumber, setBusinessNumber } from '@shared/settings.js';
import { isReady, itemStatus, setupChecklist } from '@shared/setup.js';
import { ErrorNotice, InfoNotice, Loading } from '../components/Notice.jsx';
import { Page } from '../components/Page.jsx';
import { useToast } from '../components/Toasts.jsx';
import { useCrm } from '../crm-context.js';
import { usePageTitle } from '../hooks.js';

const MODE_TEXT = {
    server: 'This server holds your API key and mints a short-lived site token whenever the page asks for one. '
        + 'The browser names a purpose (session, contacts, campaigns or phone); the server picks the scopes.',
    login: 'You sign in with your Drop Cowboy account. The page sends that sign-in to this server, which uses it to mint '
        + 'site tokens for you. No API key is needed, and the sign-in lives in this tab\'s memory only.',
    'mcp-session': 'Development only. Your AI agent minted a session token with the Drop Cowboy MCP and wrote it to '
        + '.dropcowboy/session.json. This server hands it to the page on localhost only, and every page that can use it, '
        + 'the contacts pages included, shares it.'
};

function cdnVersionText(config) {
    try {
        return cdnVersionFor(config);
    } catch {
        return '(invalid)';
    }
}

function checklistSummary(crm, readiness, items) {
    if (readiness) {
        return isReady(items) ? 'Everything required is in place.' : 'Work through the items marked "To do", then reload this page.';
    }
    if (crm.config.auth_mode === 'mcp-session') {
        return 'This mode cannot ask Drop Cowboy about your account. Your AI agent can, with get_integration_readiness.';
    }
    return 'Your account could not be checked right now, so nothing is marked.';
}

/** Does this page have a session token? Resolves to { ok } or { error }. */
function checkSession(crm) {
    if (crm.needsSignIn()) {
        const code = crm.login.isConfigured() ? 'login_required' : 'login_not_configured';
        return Promise.resolve({ error: { code } });
    }
    return crm.tokens.get('session').then(() => ({ ok: true }), (error) => ({ error }));
}

/** The readiness checklist, or null readiness when it cannot be read. */
function checkAccount(crm) {
    if (crm.needsSignIn()) {
        return Promise.resolve({ readiness: null, error: null });
    }
    return crm.readiness().then((readiness) => ({ readiness, error: null }), (error) => ({ readiness: null, error }));
}

function ChecklistItem({ item }) {
    const status = itemStatus(item);
    return (
        <li id={item.id} tabIndex={-1}>
            <span className={'status ' + status.className}>{status.label}</span>
            <div>
                <strong>{item.title}</strong>
                <p>{item.help}</p>
                {item.link && <a href={item.link.href} target="_blank" rel="noopener">{item.link.label} (opens Drop Cowboy)</a>}
            </div>
        </li>
    );
}

function Checklist({ account, businessNumber }) {
    const crm = useCrm();
    if (!account) {
        return <Loading label="Checking your account…" />;
    }
    const items = setupChecklist(account.readiness, { siteId: crm.config.site_id, businessNumber });
    return (
        <>
            {account.error && <ErrorNotice error={account.error} />}
            <p>{checklistSummary(crm, account.readiness, items)}</p>
            <ol className="checklist">
                {items.map((item) => <ChecklistItem item={item} key={item.id} />)}
            </ol>
        </>
    );
}

function BusinessNumberForm({ value, onSaved }) {
    const toast = useToast();
    function submit(event) {
        event.preventDefault();
        const saved = setBusinessNumber(String(new FormData(event.currentTarget).get('business_number') || ''));
        event.currentTarget.elements.business_number.value = saved;
        onSaved(saved);
        toast(saved ? 'Business number saved. Reload to use it in the Dock.' : 'Business number cleared.');
    }
    return (
        <form className="bizrow" onSubmit={submit}>
            <div className="field">
                <label htmlFor="business-number-input">Business number (texts are sent from it)</label>
                <input id="business-number-input" name="business_number" type="tel" autoComplete="tel" defaultValue={value} />
            </div>
            <button type="submit" className="btn">Save number</button>
        </form>
    );
}

/** Setup: how this app authenticates, what the account still needs, and local settings. */
export function SetupPage() {
    usePageTitle('Setup');
    const crm = useCrm();
    const { hash } = useLocation();
    const [session, setSession] = useState(null);
    const [account, setAccount] = useState(null);
    const [businessNumber, setBusinessNumberState] = useState(getBusinessNumber);

    useEffect(() => {
        let current = true;
        checkSession(crm).then((result) => current && setSession(result));
        checkAccount(crm).then((result) => current && setAccount(result));
        return () => {
            current = false;
        };
    }, [crm]);

    // Error notices link to /setup#funds and the like; bring that item into view.
    useEffect(() => {
        const target = account && hash ? document.getElementById(hash.slice(1)) : null;
        if (target) {
            target.scrollIntoView();
            target.focus();
        }
    }, [account, hash]);

    let sessionStatus = <Loading label="Checking the session…" />;
    if (session && session.error) {
        sessionStatus = <ErrorNotice error={session.error} />;
    } else if (session) {
        sessionStatus = (
            <InfoNotice title="Session token: ready">
                Calling, texting and the inbox in the Dock are available.
            </InfoNotice>
        );
    }

    return (
        <Page title="Setup" hint="How this app signs in, what your account still needs, and local settings.">
            <section className="card" aria-labelledby="mode-title">
                <h2 id="mode-title">How this app signs in: {crm.config.auth_mode}</h2>
                <p>{MODE_TEXT[crm.config.auth_mode] || ''}</p>
                {sessionStatus}
            </section>
            <section className="card" aria-labelledby="checklist-title">
                <h2 id="checklist-title">Account checklist</h2>
                <div aria-live="polite">
                    <Checklist account={account} businessNumber={businessNumber} />
                </div>
            </section>
            <section className="card" aria-labelledby="business-number-title">
                <h2 id="business-number-title">Business number</h2>
                <p className="hint">Stored in this browser only. It must be a number on your account that is registered for texting.</p>
                <BusinessNumberForm value={businessNumber} onSaved={setBusinessNumberState} />
            </section>
            <section className="card" aria-labelledby="details-title">
                <h2 id="details-title">Details</h2>
                <dl className="dl">
                    <dt>Site id</dt><dd className="mono">{crm.config.site_id || 'not set'}</dd>
                    <dt>Building Blocks release</dt><dd className="mono">{cdnVersionText(crm.config)}</dd>
                    <dt>Widget API</dt><dd className="mono">{crm.widgetApiBase}</dd>
                </dl>
            </section>
        </Page>
    );
}
