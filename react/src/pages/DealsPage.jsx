import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { DEAL_STAGES, archivedNote, createDealsApi, dealsAvailable, formatAmount, parseAmount, stageLabel } from '@shared/deals-api.js';
import { AppError } from '@shared/errors.js';
import { contactName } from '@shared/format.js';
import { DcContactCard } from '../blocks/DcContactCard.jsx';
import { Icon } from '../components/Icon.jsx';
import { ErrorNotice, InfoNotice, Loading } from '../components/Notice.jsx';
import { Page, WidgetTag } from '../components/Page.jsx';
import { useToast } from '../components/Toasts.jsx';
import { useCrm } from '../crm-context.js';
import { useActivityItems, useContactWidgets, usePageTitle } from '../hooks.js';
import { useAppPath } from '../layout-context.js';

const api = createDealsApi();

/** A name for each contact id the deals mention: the name, null for a contact Drop Cowboy no longer has, undefined if it could not be read. */
async function loadNames(crm, deals, known) {
    const found = new Map(known);
    const wanted = [...new Set(deals.map((deal) => deal.contact_id).filter((id) => id && !found.has(id)))];
    await Promise.all(wanted.map(async (id) => {
        try {
            const contact = await crm.contacts.get(id);
            found.set(id, contact ? contactName(contact) : null);
        } catch {
            found.set(id, undefined);
        }
    }));
    return found;
}

function ContactLabel({ deal, names }) {
    const appPath = useAppPath();
    if (!deal.contact_id) {
        return null;
    }
    const name = names.get(deal.contact_id);
    if (name) {
        return <Link to={appPath('/contacts/' + encodeURIComponent(deal.contact_id))}><Icon name="user" />{name}</Link>;
    }
    return <span className="hint">{name === null ? 'Contact deleted' : 'Contact ' + deal.contact_id.slice(0, 8)}</span>;
}

function ContactCardPanel({ deal }) {
    const { tokenManager, error } = useContactWidgets(['dc-contact-card']);
    let body = <Loading label="Loading contact card…" />;
    if (error) {
        body = <ErrorNotice error={error} />;
    } else if (tokenManager) {
        body = <DcContactCard contactId={deal.contact_id} tokenManager={tokenManager} />;
    }
    return (
        <section className="wa" aria-label={'Contact card for ' + deal.title}>
            <WidgetTag name="<dc-contact-card>" />
            {body}
        </section>
    );
}

function DealRow({ deal, names, onChange, onOpen, onDelete }) {
    const note = archivedNote(deal);
    return (
        <article className={deal.archived ? 'deal archived' : 'deal'} data-deal-id={deal.id}>
            <div className="deal-main">
                <h2>{deal.title}</h2>
                <p className="deal-meta">
                    {formatAmount(deal.amount_cents, deal.currency)} <ContactLabel deal={deal} names={names} />
                </p>
                {note && <p className="deal-note"><span className="badge">{note}</span></p>}
                {deal.notes && <p className="hint">{deal.notes}</p>}
            </div>
            <div className="deal-acts">
                <select aria-label={'Stage for ' + deal.title} value={deal.stage} onChange={(event) => onChange(deal, { stage: event.target.value })}>
                    {DEAL_STAGES.map((stage) => <option key={stage.id} value={stage.id}>{stage.label}</option>)}
                </select>
                {deal.contact_id && names.get(deal.contact_id) && (
                    <button type="button" className="btn sm" onClick={() => onOpen(deal)}><Icon name="user" />Contact card</button>
                )}
                <button type="button" className="btn sm" onClick={() => onChange(deal, { archived: !deal.archived })}>
                    {deal.archived ? 'Restore' : 'Archive'}
                </button>
                <button type="button" className="btn sm danger-o" aria-label={'Delete ' + deal.title} onClick={() => onDelete(deal)}>
                    <Icon name="trash" />Delete
                </button>
            </div>
        </article>
    );
}

function DealForm({ contacts, onCreate }) {
    const [amount, setAmount] = useState('');
    const [title, setTitle] = useState('');
    const [stage, setStage] = useState('lead');
    const [contactId, setContactId] = useState('');

    function submit(event) {
        event.preventDefault();
        onCreate({ title, amount, stage, contactId }).then((created) => {
            if (created) {
                setTitle('');
                setAmount('');
                setStage('lead');
                setContactId('');
            }
        });
    }

    return (
        <form className="card" noValidate aria-label="Add a deal" onSubmit={submit}>
            <div className="form-grid">
                <div className="field">
                    <label htmlFor="deal-title">Title</label>
                    <input id="deal-title" name="title" required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
                </div>
                <div className="field">
                    <label htmlFor="deal-amount">Amount (USD)</label>
                    <input id="deal-amount" name="amount" inputMode="decimal" placeholder="0.00" value={amount} onChange={(event) => setAmount(event.target.value)} />
                </div>
                <div className="field">
                    <label htmlFor="deal-stage">Stage</label>
                    <select id="deal-stage" name="stage" value={stage} onChange={(event) => setStage(event.target.value)}>
                        {DEAL_STAGES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                </div>
                <div className="field">
                    <label htmlFor="deal-contact">Contact</label>
                    <select id="deal-contact" name="contact_id" value={contactId} onChange={(event) => setContactId(event.target.value)}>
                        <option value="">No contact</option>
                        {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contactName(contact)}</option>)}
                    </select>
                </div>
            </div>
            <div className="actions">
                <button type="submit" className="btn primary"><Icon name="plus-square" />Add deal</button>
            </div>
        </form>
    );
}

function DealsBoard() {
    const crm = useCrm();
    const toast = useToast();
    const [stage, setStage] = useState('');
    const [showArchived, setShowArchived] = useState(false);
    const [deals, setDeals] = useState(null);
    const [names, setNames] = useState(() => new Map());
    const [contacts, setContacts] = useState([]);
    const [problem, setProblem] = useState(null);
    const [openDeal, setOpenDeal] = useState(null);
    const [version, setVersion] = useState(0);
    const namesRef = useRef(names);
    const reload = useCallback(() => setVersion((current) => current + 1), []);

    const run = useCallback(async (action) => {
        setProblem(null);
        try {
            return await action();
        } catch (err) {
            setProblem(err);
            return undefined;
        }
    }, []);

    // Reads the list again whenever the filter changes or something was saved (`version`).
    useEffect(() => {
        let active = true;
        const filter = { archived: showArchived ? 'all' : false };
        if (stage) {
            filter.stage = stage;
        }
        api.list(filter)
            .then(async (next) => ({ next, found: await loadNames(crm, next, namesRef.current) }))
            .then(({ next, found }) => {
                if (active) {
                    namesRef.current = found;
                    setNames(found);
                    setDeals(next);
                    setProblem(null);
                }
            }, (err) => active && setProblem(err));
        return () => {
            active = false;
        };
    }, [crm, stage, showArchived, version]);

    useEffect(() => {
        let active = true;
        crm.contacts.list({ limit: 100 }).then((page) => active && setContacts(page.contacts), () => {});
        return () => {
            active = false;
        };
    }, [crm]);

    // A contact deleted in Drop Cowboy archives its deals on the server; reload when that webhook arrives.
    const items = useActivityItems();
    const seen = useRef(null);
    useEffect(() => {
        if (seen.current === null) {
            seen.current = new Set(items.map((item) => item.id));
            return undefined;
        }
        const fresh = items.filter((item) => !seen.current.has(item.id));
        for (const item of items) {
            seen.current.add(item.id);
        }
        if (fresh.some((item) => item.event === 'contact.deleted' && !item.replayed)) {
            // Archiving happens right after the webhook is recorded, so give the server a moment.
            const timer = setTimeout(reload, 800);
            return () => clearTimeout(timer);
        }
        return undefined;
    }, [items, reload]);

    async function create({ title, amount, stage: chosen, contactId }) {
        return run(async () => {
            const cents = parseAmount(amount);
            if (cents === null) {
                throw new AppError('invalid_request', 'amount: enter a number such as 1250 or 1250.50.');
            }
            const body = { title: title.trim(), amount_cents: cents, stage: chosen };
            if (contactId) {
                body.contact_id = contactId;
            }
            const deal = await api.create(body);
            toast('Added ' + deal.title);
            reload();
            return true;
        });
    }

    function change(deal, changes) {
        return run(async () => {
            await api.update(deal.id, changes);
            if (changes.stage) {
                toast(deal.title + ' is now ' + stageLabel(changes.stage));
            }
            reload();
        });
    }

    function remove(deal) {
        return run(async () => {
            await api.remove(deal.id);
            setOpenDeal((current) => (current && current.id === deal.id ? null : current));
            toast('Deleted ' + deal.title);
            reload();
        });
    }

    let list = <Loading label="Loading deals…" />;
    if (deals && deals.length === 0) {
        list = (
            <div className="empty">
                <Icon name="briefcase" />
                <h2>{stage || showArchived ? 'No deals match' : 'No deals yet'}</h2>
                <p>Add a deal above. Link it to a contact to see their card here.</p>
            </div>
        );
    } else if (deals) {
        list = deals.map((deal) => (
            <DealRow key={deal.id} deal={deal} names={names} onChange={change} onOpen={setOpenDeal} onDelete={remove} />
        ));
    }

    return (
        <Page title="Deals" hint="What you are selling, kept on this server and linked to Drop Cowboy contacts. A deleted contact archives its deals.">
            <div className="problems">{problem && <ErrorNotice error={problem} />}</div>
            <DealForm contacts={contacts} onCreate={create} />
            <div className="deal-filters">
                <select id="deal-filter-stage" aria-label="Filter by stage" value={stage} onChange={(event) => setStage(event.target.value)}>
                    <option value="">All stages</option>
                    {DEAL_STAGES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
                <label htmlFor="deal-show-archived">
                    <input type="checkbox" id="deal-show-archived" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />
                    Show archived
                </label>
            </div>
            <div className="deal-list">{list}</div>
            <div className="deal-detail">{openDeal && <ContactCardPanel key={openDeal.id} deal={openDeal} />}</div>
        </Page>
    );
}

/** Deals: the example of a module of your own. The routes and the data they keep are in each server's modules/deals. */
export function DealsPage() {
    usePageTitle('Deals');
    const crm = useCrm();
    if (!dealsAvailable(crm.config)) {
        return (
            <Page title="Deals">
                <InfoNotice title="Deals need server mode">
                    Modules keep their data for a signed-in user, so they run when DC_AUTH_MODE=server. Set it in .env and restart.
                </InfoNotice>
            </Page>
        );
    }
    return <DealsBoard />;
}
