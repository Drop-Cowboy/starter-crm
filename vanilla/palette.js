import { explainError } from '/shared/errors.js';
import { PALETTE_GROUPS, paletteItems, parsePaletteInput } from '/shared/ui.js';
import { callContact, textContact } from '/shared/widgets.js';
import { toast } from './activity.js';
import { h, icon, show } from './dom.js';

const SEARCH_DELAY_MS = 200;

function optionId(index) {
    return 'palette-option-' + index;
}

/**
 * Cmd+K: find a contact, call or text one, or go to a page. Contacts come
 * from the Contacts API as you type; everything else is local.
 * @param {{ crm: object, navigate: (path: string) => Promise<void> }} options
 * @returns {{ open: () => void }}
 */
export function createPalette(options) {
    const crm = options.crm;
    let items = [];
    let active = 0;
    let contacts = { rest: '', list: [] };
    let timer = null;
    let latest = 0;

    const input = h('input', {
        id: 'palette-input',
        role: 'combobox',
        'aria-expanded': 'true',
        'aria-controls': 'palette-list',
        'aria-autocomplete': 'list',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: 'Search contacts or type a command…'
    });
    const list = h('ul', { class: 'pal-list', id: 'palette-list', role: 'listbox', 'aria-label': 'Results' });
    const empty = h('p', { class: 'pal-empty', hidden: true });
    const dialog = h('dialog', { class: 'palette', 'aria-label': 'Command palette' },
        h('div', { class: 'pal-in' },
            icon('search'),
            h('label', { class: 'visually-hidden', for: 'palette-input' }, 'Search contacts or run a command'),
            input,
            h('kbd', null, 'Esc')
        ),
        list,
        empty,
        h('div', { class: 'pal-foot' },
            h('span', null, h('kbd', null, '↑'), h('kbd', null, '↓'), ' move'),
            h('span', null, h('kbd', null, '↵'), ' run'),
            h('span', null, h('kbd', null, 'Esc'), ' close'),
            h('span', { class: 'sp' }),
            h('span', null, 'Try "call nina" or "pipeline"')
        )
    );
    document.body.appendChild(dialog);

    function draw() {
        const { rest } = parsePaletteInput(input.value);
        items = paletteItems({ input: input.value, contacts: rest && contacts.rest === rest ? contacts.list : [] });
        active = Math.min(active, Math.max(items.length - 1, 0));
        const rows = [];
        let group = null;
        items.forEach((item, index) => {
            if (item.group !== group) {
                group = item.group;
                rows.push(h('li', { role: 'presentation', class: 'pal-g' }, PALETTE_GROUPS[group]));
            }
            rows.push(h('li', {
                role: 'option',
                id: optionId(index),
                class: 'pal-o',
                'aria-selected': 'false',
                onclick: () => run(item),
                onmousemove: () => {
                    if (active !== index) {
                        markActive(index);
                    }
                }
            },
            icon(item.icon),
            h('span', { class: 'pl' }, item.label),
            item.hint ? h('span', { class: 'ps' }, item.hint) : null));
        });
        show(list, rows);
        empty.hidden = items.length > 0;
        empty.textContent = 'No matches for "' + input.value.trim() + '".';
        markActive(active);
    }

    // Moves the highlight without redrawing, so a click lands on the row it started on.
    function markActive(index) {
        active = index;
        for (const option of list.querySelectorAll('[role="option"]')) {
            const selected = option.id === optionId(index);
            option.setAttribute('aria-selected', String(selected));
            const kbd = option.querySelector('kbd');
            if (selected && !kbd) {
                option.appendChild(h('kbd', { 'aria-hidden': 'true' }, '↵'));
                option.scrollIntoView({ block: 'nearest' });
            } else if (!selected && kbd) {
                kbd.remove();
            }
        }
        if (items.length) {
            input.setAttribute('aria-activedescendant', optionId(index));
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    }

    function lookUp() {
        const { rest } = parsePaletteInput(input.value);
        clearTimeout(timer);
        if (!rest || rest === contacts.rest) {
            return;
        }
        const id = ++latest;
        timer = setTimeout(async () => {
            let found = [];
            try {
                found = (await crm.contacts.find(rest, { offset: 0, limit: 5 })).contacts;
            } catch {
                // Pages and actions still work without contacts.
            }
            if (id === latest) {
                contacts = { rest, list: found };
                draw();
            }
        }, SEARCH_DELAY_MS);
    }

    async function run(item) {
        dialog.close();
        const { action } = item;
        if (action.type === 'navigate') {
            options.navigate(action.path);
            return;
        }
        try {
            await (action.type === 'call' ? callContact : textContact)(crm, action.contact);
        } catch (err) {
            const g = explainError(err);
            toast(g.title + ': ' + g.message);
        }
    }

    input.addEventListener('input', () => {
        active = 0;
        draw();
        lookUp();
    });
    input.addEventListener('keydown', (event) => {
        if (!items.length) {
            return;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            markActive((active + 1) % items.length);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            markActive((active - 1 + items.length) % items.length);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            run(items[active]);
        }
    });
    function reset() {
        clearTimeout(timer);
        latest += 1;
        input.value = '';
        active = 0;
        contacts = { rest: '', list: [] };
    }

    // The close event arrives a task later, possibly after a quick reopen.
    dialog.addEventListener('close', () => {
        if (!dialog.open) {
            reset();
        }
    });

    return {
        open() {
            if (dialog.open) {
                return;
            }
            reset();
            draw();
            dialog.showModal();
            input.focus();
        }
    };
}
