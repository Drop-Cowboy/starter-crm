import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { fromWebhook } from '@shared/activity.js';
import { explainError } from '@shared/errors.js';
import { connectEvents } from '@shared/events.js';
import { formatDate } from '@shared/format.js';
import { getThemeChoice, setThemeChoice } from '@shared/settings.js';
import {
    applyThemeChoice,
    isCurrentPath,
    isPaletteShortcut,
    MODULES,
    NAV_PAGES,
    nextThemeChoice,
    readLayout,
    SETUP_PAGE,
    showsContactList,
    THEME_DISPLAY,
    themeButtonLabel
} from '@shared/ui.js';
import { useCrm } from '../crm-context.js';
import { useActivityItems, useMediaQuery } from '../hooks.js';
import { LayoutContext, useAppPath, withLayout } from '../layout-context.js';
import { ActivityList } from './ActivityList.jsx';
import { CommandPalette } from './CommandPalette.jsx';
import { ContactList } from './ContactList.jsx';
import { Icon } from './Icon.jsx';
import { ErrorNotice } from './Notice.jsx';
import { useToast } from './Toasts.jsx';

// Same breakpoints as crm.css: the context rail fits from 85rem, and below
// 48rem the app switches to its phone layout.
const WIDE = '(min-width: 85rem)';
const PHONE = '(max-width: 47.99rem)';

const SHORTCUT_LABEL = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';

const STATUS_TEXT = {
    connecting: 'Connecting to live events…',
    open: 'Live: webhooks appear here as Drop Cowboy sends them.',
    reconnecting: 'Live events disconnected. Reconnecting…'
};

const STATUS_SHORT = {
    connecting: 'Connecting…',
    open: 'Live events connected',
    reconnecting: 'Reconnecting…'
};

function contactIdOf(pathname) {
    const match = /^\/contacts\/([^/]+)$/.exec(pathname);
    return match && match[1] !== 'new' ? match[1] : null;
}

function selectionOf(pathname) {
    if (pathname === '/contacts/new') {
        return 'new';
    }
    return contactIdOf(pathname) ? 'contact' : 'none';
}

function Account() {
    const crm = useCrm();
    const mode = <span className="modepill"><Icon name="key" />Mode: {crm.config.auth_mode}</span>;
    const toast = useToast();
    if (!crm.login) {
        if (crm.config.auth_mode === 'server' && crm.identity.current().identity === 'passcode') {
            const signOut = () => crm.identity.signOut().then(
                () => window.location.reload(),
                (err) => toast('Could not sign out: ' + err.message)
            );
            return (
                <div className="account" id="account">
                    {mode}
                    <button type="button" className="btn sm" onClick={signOut}>Sign out</button>
                </div>
            );
        }
        return <div className="account" id="account">{mode}</div>;
    }
    let status = <span>Sign-in not set up</span>;
    if (crm.login.isSignedIn()) {
        status = <span>Signed in</span>;
    } else if (crm.login.isConfigured()) {
        status = (
            <button type="button" className="btn primary sm" onClick={() => crm.login.signIn(window.location.pathname)}>
                Sign in with Drop Cowboy
            </button>
        );
    }
    return <div className="account" id="account">{mode}{status}</div>;
}

/** Moves through system, light and dark, and remembers the choice in this browser. */
function ThemeButton() {
    const [choice, setChoice] = useState(getThemeChoice);
    const label = themeButtonLabel(choice);
    useEffect(() => {
        applyThemeChoice(document.documentElement, choice);
    }, [choice]);
    return (
        <button
            className="topbtn"
            id="theme-button"
            type="button"
            aria-label={label}
            title={label}
            onClick={() => setChoice(setThemeChoice(nextThemeChoice(choice)))}
        >
            <Icon name={THEME_DISPLAY[choice].icon} />
            <span className="tlb">{THEME_DISPLAY[choice].label}</span>
        </button>
    );
}

function TopBar({ activityRef, activityOpen, unseen, onActivity, onPalette }) {
    const appPath = useAppPath();
    return (
        <header className="top">
            <Link className="brand" to={appPath('/contacts')}>
                <span className="logo" aria-hidden="true">S</span>
                <span><span className="bn">Starter CRM</span> <span className="bs">Built on Drop Cowboy Building Blocks</span></span>
            </Link>
            <button className="cmdk" id="palette-button" type="button" aria-keyshortcuts="Meta+K Control+K" aria-label="Search or run a command" onClick={onPalette}>
                <Icon name="search" />
                <span className="cl">Search or run a command…</span>
                <kbd aria-hidden="true">{SHORTCUT_LABEL}</kbd>
            </button>
            <span className="sp" />
            <ThemeButton />
            <button
                className="topbtn"
                id="activity-button"
                type="button"
                ref={activityRef}
                aria-controls="context"
                aria-expanded={activityOpen}
                aria-label={unseen ? 'Activity, ' + unseen + ' new' : 'Activity'}
                onClick={onActivity}
            >
                <Icon name="activity" />
                <span className="tlb">Activity</span>
                <span className="cnt" hidden={!unseen}>{unseen}</span>
            </button>
            <Account />
        </header>
    );
}

function NavItem({ to, label, icon, ariaLabel, className }) {
    const { pathname } = useLocation();
    const appPath = useAppPath();
    return (
        <li>
            <Link
                to={appPath(to)}
                className={className}
                title={label}
                aria-label={ariaLabel}
                aria-current={isCurrentPath(pathname, to) ? 'page' : undefined}
            >
                <Icon name={icon} />
                <span className="nl">{label}</span>
            </Link>
        </li>
    );
}

function MainNav({ expanded, onToggle }) {
    return (
        <nav data-region="nav" aria-label="Main">
            <ul className="nav-list">
                {NAV_PAGES.map((page) => <NavItem key={page.path} to={page.path} label={page.label} icon={page.icon} />)}
            </ul>
            <div className="nav-sec" id="modules-heading">Your modules</div>
            <ul className="nav-list mods" aria-labelledby="modules-heading">
                {MODULES.map((m) => <NavItem key={m.id} to={'/modules/' + m.id} label={m.label} icon={m.icon} />)}
                <NavItem to="/modules/add" label="Add yours" icon="plus-square" ariaLabel="Add your module" className="addmod" />
            </ul>
            <span className="sp" />
            <ul className="nav-list bottom">
                <NavItem to={SETUP_PAGE.path} label={SETUP_PAGE.label} icon={SETUP_PAGE.icon} />
            </ul>
            <button
                className="nav-toggle"
                type="button"
                aria-controls="app"
                aria-expanded={expanded}
                aria-label={expanded ? 'Collapse navigation' : 'Expand navigation'}
                onClick={onToggle}
            >
                <Icon name={expanded ? 'chevrons-left' : 'chevrons-right'} />
                <span className="nl" aria-hidden="true">Collapse</span>
            </button>
        </nav>
    );
}

function Banner({ error, onDismiss }) {
    return (
        <div className="banner">
            <span className="bi" aria-hidden="true"><Icon name="alert" /></span>
            <ErrorNotice error={error} full />
            <button type="button" className="iconbtn" aria-label="Dismiss notice" onClick={onDismiss}><Icon name="x" /></button>
        </div>
    );
}

/** What the Contacts API knows about the contact on screen, beside it. */
function ContactFacts({ contact }) {
    const appPath = useAppPath();
    return (
        <section className="ctx-sec" aria-labelledby="context-contact-heading">
            <h3 className="ah" id="context-contact-heading">Details</h3>
            {contact.created_at && (
                <div className="kv"><span className="k">Created</span> <span>{formatDate(contact.created_at)}</span></div>
            )}
            <div className="kv"><span className="k">Do not call:</span> <span>{contact.dnc ? 'On list' : 'Not listed'}</span></div>
            <Link className="ctx-link" to={appPath('/pipeline')}>Open in Pipeline <Icon name="arrow-right" /></Link>
        </section>
    );
}

function ContextRegion({ context, facts, status, closeRef, onClose }) {
    const crm = useCrm();
    const items = useActivityItems();
    const drawer = context === 'drawer';
    return (
        <aside data-region="context" id="context" aria-labelledby="context-heading">
            <div className="ctx-h">
                <h2 id="context-heading">{drawer ? 'Activity' : 'Context'}</h2>
                <span className="sp" />
                <button type="button" className="iconbtn" id="context-close" ref={closeRef} aria-label="Close panel" onClick={onClose}>
                    <Icon name={drawer ? 'x' : 'chevron-right'} />
                </button>
            </div>
            <div className="ctx-scroll">
                <div id="context-contact">{facts && <ContactFacts contact={facts} />}</div>
                <section className="ctx-sec" aria-labelledby="activity-heading">
                    <h3 className="ah" id="activity-heading">Activity</h3>
                    <p className="hint" id="activity-status">{STATUS_TEXT[status]}</p>
                    <ActivityList items={items} id="activity-list" label="Recent activity" />
                    <p className="feed-empty" id="activity-empty" hidden={items.length > 0}>
                        No activity yet. Webhooks appear here as Drop Cowboy sends them.
                    </p>
                </section>
            </div>
            <div className="ctx-foot">
                <strong><span className="pulse" data-status={status} aria-hidden="true" /><span id="activity-connection">{STATUS_SHORT[status]}</span></strong>
                <span id="activity-mode">Mode: {crm.config.auth_mode}</span>
            </div>
        </aside>
    );
}

/**
 * The Dock is mounted once, for every page, and stays across navigation.
 * Its errors carry a code (and for consent a reason), so they are explained
 * rather than shown raw.
 */
function useDock(onFatal) {
    const crm = useCrm();
    const toast = useToast();
    useEffect(() => {
        if (crm.needsSignIn() || !crm.cdn) {
            return undefined;
        }
        let active = true;
        let off = null;
        crm.startDock().then(
            (dock) => {
                if (active) {
                    off = dock.addErrorListener((detail) => {
                        const g = explainError(detail);
                        toast(g.title + ': ' + g.message);
                    });
                }
            },
            (err) => active && onFatal(err)
        );
        return () => {
            active = false;
            if (off) {
                off();
            }
        };
    }, [crm, toast, onFatal]);
}

/**
 * Live webhooks from the server go into the activity log, next to the
 * Dock's own events. Calls `onItem` for each new item, but not for the
 * history the server replays when the page loads; returns the connection
 * status.
 */
function useLiveEvents(onItem) {
    const crm = useCrm();
    const [status, setStatus] = useState('connecting');
    const added = useEffectEvent(onItem);

    useEffect(() => crm.activity.subscribe((list, newest) => {
        if (!newest.replayed) {
            added(newest);
        }
    }), [crm]);

    useEffect(() => {
        const events = connectEvents({
            onEvent: (event, meta) => crm.activity.add(fromWebhook(event, meta)),
            onStatus: setStatus
        });
        return () => events.close();
    }, [crm]);

    return status;
}

/**
 * Moves focus to the page content on load and after each navigation, so
 * screen readers announce the page and keyboard users start at the top.
 */
function useFocusOnNavigate(mainRef) {
    const { pathname } = useLocation();
    useEffect(() => {
        mainRef.current.focus();
    }, [pathname, mainRef]);
}

/**
 * The app shell: top bar, navigation, the contacts list beside contact
 * pages, the page itself, and the context panel with live activity. On
 * contact pages the context panel is a rail; elsewhere the Activity button
 * opens it as a drawer.
 */
export function Layout() {
    const crm = useCrm();
    const toast = useToast();
    const location = useLocation();
    const navigate = useNavigate();
    const { pathname } = location;
    const main = useRef(null);
    const activityButton = useRef(null);
    const contextClose = useRef(null);
    const visibleRef = useRef(false);
    const [layout] = useState(() => readLayout(location.search));
    const [banner, setBanner] = useState(crm.startupError);
    const [navExpanded, setNavExpanded] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    // null until the user opens or closes the rail: then it follows the screen width.
    const [railPref, setRailPref] = useState(null);
    // The drawer belongs to the page it was opened on, so navigating closes it.
    const [drawerAt, setDrawerAt] = useState(null);
    const [contactFacts, setContactFacts] = useState(null);
    const [contactsVersion, setContactsVersion] = useState(0);
    const [unseen, setUnseen] = useState(0);
    const wide = useMediaQuery(WIDE);
    const phone = useMediaQuery(PHONE);

    const onContact = contactIdOf(pathname) !== null;
    const listOn = showsContactList(pathname);
    const railOpen = onContact && !phone && (railPref === null ? wide : railPref);
    let context = 'closed';
    if (railOpen) {
        context = 'rail';
    } else if (drawerAt === pathname) {
        context = 'drawer';
    }
    const activityVisible = context !== 'closed';

    const [wasVisible, setWasVisible] = useState(activityVisible);
    if (wasVisible !== activityVisible) {
        setWasVisible(activityVisible);
        if (activityVisible) {
            setUnseen(0);
        }
    }

    useEffect(() => {
        visibleRef.current = activityVisible;
    }, [activityVisible]);

    useDock(setBanner);
    useFocusOnNavigate(main);
    const status = useLiveEvents((item) => {
        toast(item.title + (item.detail ? ': ' + item.detail : ''));
        if (!visibleRef.current) {
            setUnseen((n) => n + 1);
        }
    });

    // Fired by any widget's token manager when it can no longer get a token.
    useEffect(() => {
        function expired() {
            setBanner({ code: crm.login ? 'login_expired' : 'unauthorized' });
        }
        window.addEventListener('dc-session-expired', expired);
        return () => window.removeEventListener('dc-session-expired', expired);
    }, [crm]);

    // Embedded stays embedded, even after a link that forgot the layout.
    useEffect(() => {
        if (layout === 'embedded' && readLayout(location.search) !== 'embedded') {
            navigate(withLayout(location.pathname + location.search + location.hash, layout), { replace: true });
        }
    }, [layout, location, navigate]);

    useEffect(() => {
        if (layout !== 'full') {
            return undefined;
        }
        function shortcut(event) {
            if (isPaletteShortcut(event) && !document.querySelector('dialog[open]')) {
                event.preventDefault();
                setPaletteOpen(true);
            }
        }
        document.addEventListener('keydown', shortcut);
        return () => document.removeEventListener('keydown', shortcut);
    }, [layout]);

    const closeDrawer = useCallback(() => {
        setDrawerAt(null);
        if (activityButton.current) {
            activityButton.current.focus();
        }
    }, []);

    useEffect(() => {
        if (context !== 'drawer') {
            return undefined;
        }
        contextClose.current.focus();
        function escape(event) {
            if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
                event.preventDefault();
                closeDrawer();
            }
        }
        document.addEventListener('keydown', escape);
        return () => document.removeEventListener('keydown', escape);
    }, [context, closeDrawer]);

    const toggleRail = useCallback(() => {
        setRailPref(!railOpen);
        setDrawerAt(null);
    }, [railOpen]);

    const contactsChanged = useCallback(() => setContactsVersion((v) => v + 1), []);

    function activityClicked() {
        if (context === 'rail') {
            setRailPref(false);
        } else if (context === 'drawer') {
            closeDrawer();
        } else if (onContact && wide && !phone) {
            setRailPref(true);
        } else {
            setDrawerAt(pathname);
        }
    }

    function contextClosed() {
        if (context === 'drawer') {
            closeDrawer();
            return;
        }
        setRailPref(false);
        (main.current.querySelector('.ctx-toggle') || main.current).focus();
    }

    const layoutValue = useMemo(
        () => ({ layout, contactsVersion, contactsChanged, setContactFacts, context, toggleRail }),
        [layout, contactsVersion, contactsChanged, context, toggleRail]
    );

    return (
        <LayoutContext value={layoutValue}>
            <a className="skip-link" href="#main">Skip to content</a>
            <div
                className="app"
                id="app"
                data-layout={layout}
                data-nav={navExpanded ? 'expanded' : 'collapsed'}
                data-list={listOn ? 'on' : 'off'}
                data-selection={listOn ? selectionOf(pathname) : undefined}
                data-context={context}
            >
                {layout === 'full' && (
                    <TopBar
                        activityRef={activityButton}
                        activityOpen={activityVisible}
                        unseen={unseen}
                        onActivity={activityClicked}
                        onPalette={() => setPaletteOpen(true)}
                    />
                )}
                <div id="banner">{banner && <Banner error={banner} onDismiss={() => setBanner(null)} />}</div>
                <div className="shell">
                    {layout === 'full' && <MainNav expanded={navExpanded} onToggle={() => setNavExpanded(!navExpanded)} />}
                    {listOn && <ContactList />}
                    <main data-region="main" id="main" tabIndex={-1} ref={main}>
                        <Outlet />
                    </main>
                    <ContextRegion
                        context={context}
                        facts={onContact ? contactFacts : null}
                        status={status}
                        closeRef={contextClose}
                        onClose={contextClosed}
                    />
                    <div className="drawer-scrim" hidden={context !== 'drawer'} onClick={closeDrawer} />
                </div>
            </div>
            <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        </LayoutContext>
    );
}
