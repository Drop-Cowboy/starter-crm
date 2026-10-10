import { h, show } from '../dom.js';
import { page } from '../page.js';

export function renderNotFound(main) {
    show(main, page('Page not found', null,
        h('p', null, 'There is no page at this address.'),
        h('p', null, h('a', { href: '/contacts' }, 'Go to contacts'))
    ));
}
