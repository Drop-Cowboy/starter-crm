import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { changedFields } from '@shared/contacts-api.js';
import { contactInitials, contactName, formatDate, formatPhone } from '@shared/format.js';
import { callContact, focusContact, textContact } from '@shared/widgets.js';
import { DcContactCard } from '../blocks/DcContactCard.jsx';
import { ActivityList } from '../components/ActivityList.jsx';
import { ConsentForm } from '../components/ConsentForm.jsx';
import { ContactForm } from '../components/ContactForm.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNotice, InfoNotice, Loading } from '../components/Notice.jsx';
import { DncBadge, WidgetTag } from '../components/Page.jsx';
import { useToast } from '../components/Toasts.jsx';
import { useCrm } from '../crm-context.js';
import { useActivityItems, useContactWidgets, useModalDialog, usePageTitle } from '../hooks.js';
import { useAppPath, useLayout } from '../layout-context.js';

const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'activity', label: 'Activity' },
    { id: 'consent', label: 'Consent' },
    { id: 'edit', label: 'Edit' }
];

// Arrow keys, Home and End move between tabs and open the one they land on.
const TAB_KEYS = {
    ArrowRight: (index) => (index + 1) % TABS.length,
    ArrowLeft: (index) => (index - 1 + TABS.length) % TABS.length,
    Home: () => 0,
    End: () => TABS.length - 1
};

function Tabs({ active, onChange }) {
    const list = useRef(null);

    function keyDown(event) {
        const move = TAB_KEYS[event.key];
        if (!move) {
            return;
        }
        event.preventDefault();
        const next = TABS[move(TABS.findIndex((tab) => tab.id === active))].id;
        onChange(next);
        list.current.querySelector('#tab-' + next).focus();
    }

    return (
        <div className="tabs" role="tablist" aria-label="Contact sections" ref={list} onKeyDown={keyDown}>
            {TABS.map((tab) => (
                <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    className="tab"
                    id={'tab-' + tab.id}
                    aria-controls={'panel-' + tab.id}
                    aria-selected={tab.id === active}
                    tabIndex={tab.id === active ? 0 : -1}
                    onClick={() => onChange(tab.id)}
                >
                    {tab.label}
                </button>
            ))}
        </div>
    );
}

function TabPanel({ id, active, children }) {
    return (
        <div role="tabpanel" className="tabpanel" id={'panel-' + id} aria-labelledby={'tab-' + id} tabIndex={0} hidden={id !== active}>
            {children}
        </div>
    );
}

function Profile({ contact, onCall, onText, onConsent }) {
    const { context, toggleRail } = useLayout();
    const railShowing = context === 'rail';
    const hasSubline = contact.company || contact.main_phone || contact.email;
    return (
        <header className="profile">
            <span className="av lg" aria-hidden="true">{contactInitials(contact)}</span>
            <div className="pinfo">
                <h1>{contactName(contact)}{contact.dnc && <> <DncBadge /></>}</h1>
                {hasSubline && (
                    <p className="subline">
                        {contact.company && <span><Icon name="building" />{contact.company}</span>}
                        {contact.main_phone && <> <a href={'tel:' + contact.main_phone}><Icon name="phone" />{formatPhone(contact.main_phone)}</a></>}
                        {contact.email && <> <a href={'mailto:' + contact.email}><Icon name="mail" />{contact.email}</a></>}
                    </p>
                )}
                <p className="meta">
                    {contact.created_at && <><span><Icon name="calendar" />{'Created ' + formatDate(contact.created_at)}</span> </>}
                    <span><Icon name="ban" />{'Do not call: ' + (contact.dnc ? 'On list' : 'Not listed')}</span>
                </p>
            </div>
            <div className="acts">
                <button type="button" className="btn primary" disabled={!contact.main_phone} onClick={onCall}>
                    <Icon name="phone" />Call
                </button>
                <button type="button" className="btn" disabled={!contact.main_phone} onClick={onText}>
                    <Icon name="message" />Text
                </button>
                <button type="button" className="btn" data-consent="" aria-label="Record consent" onClick={onConsent}>
                    <Icon name="shield" /><span className="l-full">Record consent</span><span className="l-short">Consent</span>
                </button>
                <button
                    type="button"
                    className="iconbtn ctx-toggle"
                    aria-controls="context"
                    aria-expanded={railShowing}
                    aria-label={railShowing ? 'Hide context panel' : 'Show context panel'}
                    title={railShowing ? 'Hide context panel' : 'Show context panel'}
                    onClick={toggleRail}
                >
                    <Icon name="panel-right" />
                </button>
            </div>
        </header>
    );
}

function DeleteDialog({ contact, open, onCancel, onConfirm }) {
    const ref = useModalDialog(open);
    return (
        <dialog ref={ref} className="dlg" aria-labelledby="delete-title" onClose={onCancel}>
            <h2 id="delete-title">Delete {contactName(contact)}?</h2>
            <p>The contact is removed from Drop Cowboy. This cannot be undone here.</p>
            <div className="actions">
                <button type="button" className="btn sec" onClick={onCancel}>Cancel</button>
                <button type="button" className="btn danger" onClick={onConfirm}>Delete contact</button>
            </div>
        </dialog>
    );
}

/** Records consent in a side sheet; the form inside is fresh each time it opens. */
function ConsentSheet({ contact, open, onClose, onRecorded }) {
    const ref = useModalDialog(open);
    useEffect(() => {
        const first = open && ref.current.querySelector('input');
        if (first) {
            first.focus();
        }
    }, [open, ref]);
    return (
        <dialog ref={ref} className="sheet" aria-labelledby="consent-sheet-title" onClose={onClose}>
            <div className="sheet-h">
                <span className="si" aria-hidden="true"><Icon name="shield" /></span>
                <div>
                    <h2 id="consent-sheet-title">Record consent</h2>
                    <p className="hint">{'for ' + contactName(contact)}</p>
                </div>
                <button type="button" className="iconbtn" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
            </div>
            {open && <ConsentForm contact={contact} labelledBy="consent-sheet-title" onCancel={onClose} onRecorded={onRecorded} />}
        </dialog>
    );
}

/**
 * The Drop Cowboy contact card. It loads the contact and its timeline itself
 * with the contacts token manager; `version` changes after a save so it reloads.
 */
function ContactCard({ contact, version, onCall, onText }) {
    const toast = useToast();
    const { tokenManager, error } = useContactWidgets(['dc-contact-card']);
    let body = <Loading label="Loading contact card…" />;
    if (error) {
        body = <ErrorNotice error={error} />;
    } else if (tokenManager) {
        body = (
            <DcContactCard
                key={version}
                contactId={contact.id}
                tokenManager={tokenManager}
                onCall={onCall}
                onText={onText}
                onAddCampaign={() => toast('Campaigns are read-only in this starter. Add contacts to campaigns in Drop Cowboy.')}
            />
        );
    }
    return (
        <section className="wa" aria-label="Drop Cowboy contact card">
            <WidgetTag name="<dc-contact-card>" />
            {body}
        </section>
    );
}

/** This contact's share of the live activity log, as it arrives. */
function ContactActivity({ contact }) {
    const items = useActivityItems().filter((item) => item.contactId === contact.id);
    const name = contactName(contact);
    return (
        <>
            <ActivityList items={items} label={'Activity for ' + name} hidden={!items.length} />
            <p className="feed-empty" hidden={items.length > 0}>
                {'Nothing yet for ' + name + '. Calls, texts and consent changes appear here as they happen.'}
            </p>
            <p className="hint">The full history is in the timeline on the Overview tab.</p>
        </>
    );
}

/**
 * One contact: the editable fields come from the REST API, and the Drop
 * Cowboy contact card (with its activity timeline) shows what happened with
 * them. Call and Text hand the contact to the Dock.
 */
function ContactDetail({ initial }) {
    const crm = useCrm();
    const toast = useToast();
    const navigate = useNavigate();
    const appPath = useAppPath();
    const { contactsChanged, setContactFacts } = useLayout();
    const [searchParams] = useSearchParams();
    const [contact, setContact] = useState(initial);
    const [version, setVersion] = useState(0);
    const [problem, setProblem] = useState(null);
    const [tab, setTab] = useState('overview');
    const [consentOpen, setConsentOpen] = useState(false);
    const [confirming, setConfirming] = useState(false);
    usePageTitle(contactName(contact));

    // The Dock follows the contact on screen, and lets go when the page closes.
    // If calling is not set up yet the banner already says why, and the rest
    // of this page works without the Dock.
    useEffect(() => {
        focusContact(crm, initial).catch(() => {});
        return () => {
            focusContact(crm, null).catch(() => {});
        };
    }, [crm, initial]);

    useEffect(() => {
        setContactFacts(contact);
    }, [contact, setContactFacts]);

    useEffect(() => () => setContactFacts(null), [setContactFacts]);

    async function run(action) {
        setProblem(null);
        try {
            await action();
        } catch (err) {
            setProblem(err);
        }
    }

    const call = () => run(() => callContact(crm, contact));
    const text = () => run(() => textContact(crm, contact));

    function remove() {
        setConfirming(false);
        run(async () => {
            await crm.contacts.remove(contact.id);
            contactsChanged();
            toast('Deleted ' + contactName(contact));
            navigate(appPath('/contacts'));
        });
    }

    async function save(values) {
        const saved = await crm.contacts.update(contact.id, changedFields(contact, values));
        setContact(saved);
        setVersion(version + 1);
        contactsChanged();
        toast('Saved ' + contactName(saved));
    }

    function recorded() {
        setConsentOpen(false);
        setVersion((v) => v + 1);
        toast('Recorded consent for ' + contactName(contact));
    }

    return (
        <div className="contact-view">
            <Link className="back" to={appPath('/contacts')}><Icon name="chevron-left" />Contacts</Link>
            <Profile contact={contact} onCall={call} onText={text} onConsent={() => setConsentOpen(true)} />
            {searchParams.get('existing') === '1' && (
                <InfoNotice title="Already in your contacts">
                    A contact with that phone or email already existed, so it was opened instead. Its empty fields were filled in.
                </InfoNotice>
            )}
            <div className="problems">{problem && <ErrorNotice error={problem} />}</div>
            {!contact.main_phone && <p className="hint">Add a phone number to call or text.</p>}
            <Tabs active={tab} onChange={setTab} />
            <TabPanel id="overview" active={tab}>
                <ContactCard contact={contact} version={version} onCall={call} onText={text} />
            </TabPanel>
            <TabPanel id="activity" active={tab}>
                <ContactActivity contact={contact} />
            </TabPanel>
            <TabPanel id="consent" active={tab}>
                <section className="card cta-card" aria-labelledby="consent-tab-heading">
                    <h2 id="consent-tab-heading">Consent</h2>
                    <p>
                        Texts and calls to US numbers need consent on record, unless your team turned on "Use existing
                        contact consent" in Drop Cowboy. Opt-outs, STOP replies and Do Not Call always block, whatever is
                        recorded.
                    </p>
                    <button type="button" className="btn primary" onClick={() => setConsentOpen(true)}>
                        <Icon name="shield" />Record consent
                    </button>
                </section>
            </TabPanel>
            <TabPanel id="edit" active={tab}>
                <h2>Edit details</h2>
                <ContactForm values={contact} submitLabel="Save changes" onSubmit={save} />
                <section className="card danger-zone" aria-labelledby="danger-zone-heading">
                    <h2 id="danger-zone-heading">Danger zone</h2>
                    <div className="dz-row">
                        <p>Delete this contact from Drop Cowboy. This cannot be undone here.</p>
                        <button type="button" className="btn danger-o" onClick={() => setConfirming(true)}>
                            <Icon name="trash" />Delete contact
                        </button>
                    </div>
                </section>
            </TabPanel>
            <ConsentSheet contact={contact} open={consentOpen} onClose={() => setConsentOpen(false)} onRecorded={recorded} />
            <DeleteDialog contact={contact} open={confirming} onCancel={() => setConfirming(false)} onConfirm={remove} />
        </div>
    );
}

export function ContactPage() {
    usePageTitle('Contact');
    const crm = useCrm();
    const appPath = useAppPath();
    const { id } = useParams();
    const [state, setState] = useState({ id: null, contact: null, error: null });

    useEffect(() => {
        let current = true;
        crm.contacts.get(id).then(
            (contact) => current && setState({ id, contact, error: null }),
            (error) => current && setState({ id, contact: null, error })
        );
        return () => {
            current = false;
        };
    }, [crm, id]);

    if (state.id !== id) {
        return <div className="page"><Loading label="Loading contact…" /></div>;
    }
    if (state.error) {
        return (
            <div className="page">
                <Link className="back" to={appPath('/contacts')}><Icon name="chevron-left" />Contacts</Link>
                <header className="page-h"><h1>This contact could not load</h1></header>
                <ErrorNotice error={state.error} />
            </div>
        );
    }
    if (!state.contact) {
        return (
            <div className="page">
                <h1>Contact not found</h1>
                <p>No contact has that id. It may have been deleted.</p>
                <Link to={appPath('/contacts')}>Back to contacts</Link>
            </div>
        );
    }
    return <ContactDetail key={id} initial={state.contact} />;
}
