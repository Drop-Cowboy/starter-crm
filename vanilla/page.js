import { h } from './dom.js';

/**
 * The frame of a full-width page in the main region: a heading, an optional
 * one-line hint, then the page's content.
 * @param {string} title
 * @param {string | null} hint
 * @param {...(Node | null)} content
 */
export function page(title, hint, ...content) {
    return h('div', { class: 'page' },
        h('header', { class: 'page-h' }, h('h1', null, title), hint ? h('p', { class: 'hint' }, hint) : null),
        content
    );
}

/**
 * The label above a Drop Cowboy widget, naming its element, so a developer
 * reading the starter sees which parts are widgets.
 * @param {string} name   an element such as "dc-pipeline-board", or a name such as "Campaign hub"
 */
export function widgetTag(name) {
    return h('div', { class: 'wa-tag' },
        h('span', { class: 'dcm', 'aria-hidden': 'true' }, 'DC'),
        'Drop Cowboy widget · ',
        h('code', null, name.startsWith('dc-') ? '<' + name + '>' : name)
    );
}

/**
 * The frame around a Drop Cowboy widget: its tag, then the widget (or its
 * loading and error states). `grow` lets it fill the rest of the page.
 * @param {string} name
 * @param {{ grow?: boolean, tag?: string, attrs?: object }} options
 * @param {...(Node | null)} content
 */
export function widgetFrame(name, options, ...content) {
    const attrs = Object.assign({ class: options.grow ? 'wa grow' : 'wa' }, options.attrs);
    return h(options.tag || 'div', attrs, widgetTag(name), content);
}
