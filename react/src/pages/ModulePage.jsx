import { useParams } from 'react-router';
import { MODULES } from '@shared/ui.js';
import { Icon } from '../components/Icon.jsx';
import { Page } from '../components/Page.jsx';
import { usePageTitle } from '../hooks.js';
import { NotFoundPage } from './NotFoundPage.jsx';

const ADD_MODULE = { id: 'add', label: 'Add your module', icon: 'plus-square' };

/** A placeholder for one of your own screens, listed under "Your modules". */
export function ModulePage() {
    const { id } = useParams();
    const module = id === ADD_MODULE.id ? ADD_MODULE : MODULES.find((m) => m.id === id);
    if (!module) {
        return <NotFoundPage />;
    }
    return <ModulePlaceholder key={module.id} module={module} />;
}

function ModulePlaceholder({ module }) {
    usePageTitle(module.label);
    const screen = module.id === ADD_MODULE.id ? 'module' : module.label;
    return (
        <Page title={module.label}>
            <div className="empty">
                <Icon name={module.icon} />
                <p>
                    This is where your {screen} screen goes. Replace this page with your own: add an entry to MODULES
                    in shared/ui.js and a page in vanilla/pages/ and react/src/pages/. Drop Cowboy widgets such
                    as {'<dc-contact-card>'} work on any page.
                </p>
            </div>
        </Page>
    );
}
