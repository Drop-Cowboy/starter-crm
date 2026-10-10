import { h } from './dom.js';

/**
 * ARIA tabs: Left and Right move between tabs, Home and End jump to the
 * ends, and moving selects. Inactive panels stay in the page, hidden, so a
 * widget inside one keeps its state.
 * @param {{ label: string, items: Array<{ id: string, label: string, content: Array<Node | null> }> }} options
 */
export function createTabs(options) {
    const buttons = [];
    const panels = [];

    function select(index, focus) {
        for (let i = 0; i < buttons.length; i++) {
            const selected = i === index;
            buttons[i].setAttribute('aria-selected', String(selected));
            buttons[i].tabIndex = selected ? 0 : -1;
            panels[i].hidden = !selected;
        }
        if (focus) {
            buttons[index].focus();
        }
    }

    function onKey(event, index) {
        const last = buttons.length - 1;
        const moves = {
            ArrowRight: index === last ? 0 : index + 1,
            ArrowLeft: index === 0 ? last : index - 1,
            Home: 0,
            End: last
        };
        if (event.key in moves) {
            event.preventDefault();
            select(moves[event.key], true);
        }
    }

    for (let i = 0; i < options.items.length; i++) {
        const item = options.items[i];
        buttons.push(h('button', {
            class: 'tab',
            type: 'button',
            role: 'tab',
            id: 'tab-' + item.id,
            'aria-controls': 'panel-' + item.id,
            onclick: () => select(i, false),
            onkeydown: (event) => onKey(event, i)
        }, item.label));
        panels.push(h('div', {
            class: 'tabpanel',
            role: 'tabpanel',
            id: 'panel-' + item.id,
            'aria-labelledby': 'tab-' + item.id,
            tabindex: '0'
        }, item.content));
    }
    select(0, false);

    return {
        list: h('div', { class: 'tabs', role: 'tablist', 'aria-label': options.label }, buttons),
        panels,
        /** Selects a tab by id, e.g. "edit". */
        show(id) {
            const index = options.items.findIndex((item) => item.id === id);
            if (index >= 0) {
                select(index, false);
            }
        }
    };
}
