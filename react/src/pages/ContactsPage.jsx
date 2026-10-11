import { Link, useNavigate } from 'react-router';
import { ContactForm } from '../components/ContactForm.jsx';
import { Icon } from '../components/Icon.jsx';
import { useCrm } from '../crm-context.js';
import { usePageTitle } from '../hooks.js';
import { useAppPath, useLayout } from '../layout-context.js';

/** /contacts: the list beside it does the work; this asks you to pick someone. */
export function ContactsPage() {
    usePageTitle('Contacts');
    const appPath = useAppPath();
    return (
        <div className="empty">
            <Icon name="users" />
            <h2>Pick a contact</h2>
            <p>Choose someone from the list, or add a new contact.</p>
            <Link className="btn primary" to={appPath('/contacts/new')}><Icon name="plus" />Add a contact</Link>
        </div>
    );
}

/** Adds a contact with the headless REST API, then opens it. */
export function NewContactPage() {
    usePageTitle('Add a contact');
    const crm = useCrm();
    const navigate = useNavigate();
    const appPath = useAppPath();
    const { contactsChanged } = useLayout();

    async function create(values) {
        const created = await crm.contacts.create(values);
        contactsChanged();
        navigate(appPath('/contacts/' + encodeURIComponent(created.contact_id) + (created.created ? '' : '?existing=1')));
    }

    return (
        <div className="page">
            <Link className="back" to={appPath('/contacts')}><Icon name="chevron-left" />Contacts</Link>
            <header className="page-h">
                <h1>Add a contact</h1>
                <p className="hint">Every contact needs a phone number or an email. If one already exists with the same phone or email, it is opened instead.</p>
            </header>
            <ContactForm submitLabel="Add contact" onSubmit={create} />
        </div>
    );
}
