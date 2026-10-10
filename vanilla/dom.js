// A tiny element builder, so pages read as a tree instead of a pile of
// createElement calls. Text always goes in as text, never as HTML, so data
// from the API can never inject markup.
//
//   h('button', { class: 'btn primary', onclick: save }, 'Save')
//
// Keys starting with "on" become event listeners. Everything else becomes an
// attribute. Widgets get their tokens as properties, set in the page code,
// never through here: attributes are visible in the DOM.

import { iconHref } from '/shared/ui.js';

/**
 * @param {string} tag
 * @param {Record<string, unknown> | null} [attrs]
 * @param {...(Node | string | number | null | false | undefined | Array<Node | string>)} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    const props = attrs || {};
    for (const key of Object.keys(props)) {
        const value = props[key];
        if (value === null || value === undefined || value === false) {
            continue;
        }
        if (key.startsWith('on') && typeof value === 'function') {
            el.addEventListener(key.slice(2), value);
        } else {
            el.setAttribute(key, value === true ? '' : String(value));
        }
    }
    append(el, children);
    return el;
}

function append(el, children) {
    for (const child of children) {
        if (child === null || child === undefined || child === false) {
            continue;
        }
        if (Array.isArray(child)) {
            append(el, child);
        } else if (child instanceof Node) {
            el.appendChild(child);
        } else {
            el.appendChild(document.createTextNode(String(child)));
        }
    }
}

/** Replaces everything inside `parent`. */
export function show(parent, ...children) {
    parent.replaceChildren();
    append(parent, children);
}

const SVG = 'http://www.w3.org/2000/svg';

/**
 * A line icon from /shared/icons.svg. Icons are decorative: the button or
 * link around one carries the accessible name.
 * @param {string} name   a symbol in the sprite, e.g. "phone"
 */
export function icon(name) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'ic');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(SVG, 'use');
    use.setAttribute('href', iconHref(name));
    svg.appendChild(use);
    return svg;
}
