import { MODULES } from '/shared/ui.js';
import { h, icon, show } from '../dom.js';
import { page } from '../page.js';
import { renderDeals } from './deals.js';
import { renderNotFound } from './not-found.js';

const ADD_MODULE = { id: 'add', label: 'Add your module', icon: 'plus-square' };

/** One of your own screens, listed under "Your modules": Deals is the worked example, the rest are placeholders. */
export function renderModule(main, context) {
    const { params } = context;
    if (params.id === 'deals') {
        return renderDeals(main, context);
    }
    const module = params.id === ADD_MODULE.id ? ADD_MODULE : MODULES.find((m) => m.id === params.id);
    if (!module) {
        renderNotFound(main);
        return undefined;
    }
    document.title = module.label + ' · Starter CRM';
    const screen = module.id === ADD_MODULE.id ? 'module' : module.label;
    show(main, page(module.label, null,
        h('div', { class: 'empty' },
            icon(module.icon),
            h('p', null, 'This is where your ' + screen + ' screen goes. Replace this page with your own: add an entry to MODULES '
                + 'in shared/ui.js, add a page in vanilla/pages/ and react/src/pages/, and send its id to that page in '
                + 'vanilla/pages/module.js and react/src/pages/ModulePage.jsx, as Deals does. Drop Cowboy widgets such as <dc-contact-card> work on any page.')
        )
    ));
    return undefined;
}
