import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { contactInitials, contactName, formatPhone, formatShortDate } from '@shared/format.js';
import { useCrm } from '../crm-context.js';
import { useAppPath, useLayout } from '../layout-context.js';
import { Icon } from './Icon.jsx';
import { ErrorNotice, Loading } from './Notice.jsx';
import { DncBadge } from './Page.jsx';

const PAGE_SIZE = 25;
const SEARCH_DELAY_MS = 300;

function ContactRow({ contact, selected }) {
    const appPath = useAppPath();
    const sub = [contact.company, formatPhone(contact.main_phone) || contact.email].filter(Boolean).join(' · ');
    return (
        <li>
            <Link
                to={appPath('/contacts/' + encodeURIComponent(contact.id))}
                aria-current={selected ? 'page' : undefined}
                data-contact-id={contact.id}
            >
                <span className="av" aria-hidden="true">{contactInitials(contact)}</span>
                <span className="who">
                    <span className="nm">{contactName(contact)}</span>
                    {contact.dnc && <> <DncBadge /></>}
                    {sub && <> <span className="sub">{sub}</span></>}
                </span>
                <span className="when">{formatShortDate(contact.created_at)}</span>
            </Link>
        </li>
    );
}

function EmptyMessage({ text }) {
    const appPath = useAppPath();
    if (text) {
        return <p className="nores">No contact matches "{text}".</p>;
    }
    return <p className="nores">No contacts yet. <Link to={appPath('/contacts/new')}>Add a contact</Link></p>;
}

/**
 * The contacts list beside the contact pages: search, page through, pick
 * one. It stays mounted while you move between contacts, and reloads when a
 * page reports a contact was added, saved or deleted.
 */
export function ContactList() {
    const crm = useCrm();
    const appPath = useAppPath();
    const { contactsVersion } = useLayout();
    const { pathname } = useLocation();
    const timer = useRef(null);
    const [query, setQuery] = useState({ text: '', offset: 0 });
    // Each result remembers the query it answers, so an older, slower
    // response never replaces a newer one, and a new query shows loading.
    const [result, setResult] = useState({ query: null, page: null, error: null });

    useEffect(() => {
        let current = true;
        crm.contacts.find(query.text, { offset: query.offset, limit: PAGE_SIZE }).then(
            (page) => current && setResult({ query, page, error: null }),
            (error) => current && setResult({ query, page: null, error })
        );
        return () => {
            current = false;
        };
    }, [crm, query, contactsVersion]);

    useEffect(() => () => clearTimeout(timer.current), []);

    function search(event) {
        event.preventDefault();
        clearTimeout(timer.current);
        const text = String(new FormData(event.currentTarget).get('q') || '').trim();
        setQuery({ text, offset: 0 });
    }

    function typed(event) {
        const text = event.currentTarget.value.trim();
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            setQuery((q) => (q.text === text ? q : { text, offset: 0 }));
        }, SEARCH_DELAY_MS);
    }

    function turn(delta) {
        setQuery({ text: query.text, offset: Math.max(0, query.offset + delta) });
    }

    const settled = result.query === query;
    const contacts = settled && result.page ? result.page.contacts : [];
    let message = null;
    if (!settled) {
        message = <Loading label="Loading contacts…" />;
    } else if (result.error) {
        message = <ErrorNotice error={result.error} />;
    } else if (!contacts.length) {
        message = <EmptyMessage text={query.text} />;
    }
    const from = query.offset + 1;
    const to = query.offset + contacts.length;

    return (
        <section data-region="list" aria-labelledby="contacts-heading">
            <div className="lh">
                <h1 id="contacts-heading">Contacts</h1>
                <Link className="btn sm" to={appPath('/contacts/new')}><Icon name="plus" />New</Link>
            </div>
            <form className="lsearch" role="search" onSubmit={search}>
                <label className="visually-hidden" htmlFor="contact-search">Search contacts</label>
                <Icon name="search" />
                <input
                    id="contact-search"
                    type="search"
                    name="q"
                    placeholder="Search name, phone, email…"
                    aria-describedby="contact-search-hint"
                    autoComplete="off"
                    onChange={typed}
                />
                <button type="submit" className="visually-hidden">Search</button>
                <p className="hint" id="contact-search-hint">A full email or phone number finds that exact contact. Anything else searches names and other fields.</p>
            </form>
            <div aria-live="polite">{message}</div>
            {contacts.length > 0 && (
                <>
                    <ul className="rows" aria-label="Contacts">
                        {contacts.map((contact) => (
                            <ContactRow
                                key={contact.id}
                                contact={contact}
                                selected={pathname === '/contacts/' + encodeURIComponent(contact.id)}
                            />
                        ))}
                    </ul>
                    <div className="pager">
                        <span className="hint">Showing {from}–{to} of {result.page.total}</span>
                        <span className="sp" />
                        <button type="button" className="pg" disabled={query.offset === 0} onClick={() => turn(-PAGE_SIZE)}>Previous</button>
                        <button type="button" className="pg" disabled={to >= result.page.total} onClick={() => turn(PAGE_SIZE)}>Next</button>
                    </div>
                </>
            )}
        </section>
    );
}
