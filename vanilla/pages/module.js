import { MODULES } from '/shared/ui.js';
import { h, icon, show } from '../dom.js';
import { page } from '../page.js';
import { renderNotFound } from './not-found.js';

const ADD_MODULE = { id: 'add', label: 'Add your module', icon: 'plus-square' };

/** A placeholder for one of your own screens, listed under "Your modules". */
export function renderModule(main, { params }) {
    const module = params.id === ADD_MODULE.id ? ADD_MODULE : MODULES.find((m) => m.id === params.id);
    if (!module) {
        renderNotFound(main);
        return;
    }
    document.title = module.label + ' · Starter CRM';
    const screen = module.id === ADD_MODULE.id ? 'module' : module.label;
    show(main, page(module.label, null,
        h('div', { class: 'empty' },
            icon(module.icon),
            h('p', null, 'This is where your ' + screen + ' screen goes. Replace this page with your own: add an entry to MODULES '
                + 'in shared/ui.js and a page in vanilla/pages/ and react/src/pages/. Drop Cowboy widgets such as <dc-contact-card> work on any page.')
        )
    ));
}
