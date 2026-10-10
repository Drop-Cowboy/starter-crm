import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { explainError } from '@shared/errors.js';
import { PALETTE_GROUPS, paletteItems, parsePaletteInput } from '@shared/ui.js';
import { callContact, textContact } from '@shared/widgets.js';
import { useCrm } from '../crm-context.js';
import { useModalDialog } from '../hooks.js';
import { useAppPath } from '../layout-context.js';
import { Icon } from './Icon.jsx';
import { useToast } from './Toasts.jsx';

const SEARCH_DELAY_MS = 200;

function optionId(index) {
    return 'palette-option-' + index;
}

/**
 * Cmd+K: find a contact, call or text one, or go to a page. Contacts come
 * from the Contacts API as you type; everything else is local.
 * @param {{ open: boolean, onClose: () => void }} props
 */
export function CommandPalette({ open, onClose }) {
    const crm = useCrm();
    const navigate = useNavigate();
    const appPath = useAppPath();
    const toast = useToast();
    const ref = useModalDialog(open);
    const [input, setInput] = useState('');
    const [active, setActive] = useState(0);
    // Contacts found for one search text; shown only while the input still asks for it.
    const [found, setFound] = useState({ rest: '', contacts: [] });
    const { rest } = parsePaletteInput(input);

    useEffect(() => {
        if (!rest) {
            return undefined;
        }
        let current = true;
        const timer = setTimeout(() => {
            crm.contacts.find(rest, { offset: 0, limit: 5 }).then(
                (page) => current && setFound({ rest, contacts: page.contacts }),
                () => current && setFound({ rest, contacts: [] })
            );
        }, SEARCH_DELAY_MS);
        return () => {
            current = false;
            clearTimeout(timer);
        };
    }, [crm, rest]);

    const contacts = rest && found.rest === rest ? found.contacts : [];
    const items = paletteItems({ input, contacts });
    const activeIndex = Math.min(active, items.length - 1);

    // Closed here rather than when `open` turns false, so a command that
    // navigates finds the palette already gone: Cmd+K works straight after.
    function close() {
        if (ref.current.open) {
            ref.current.close();
        }
        setInput('');
        setActive(0);
        onClose();
    }

    async function run(item) {
        close();
        const { action } = item;
        if (action.type === 'navigate') {
            navigate(appPath(action.path));
            return;
        }
        try {
            await (action.type === 'call' ? callContact : textContact)(crm, action.contact);
        } catch (err) {
            const g = explainError(err);
            toast(g.title + ': ' + g.message);
        }
    }

    function keyDown(event) {
        if (!items.length) {
            return;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((activeIndex + 1) % items.length);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((activeIndex - 1 + items.length) % items.length);
        } else if (event.key === 'Enter') {
            event.preventDefault();
            run(items[activeIndex]);
        }
    }

    const rows = [];
    let group = null;
    items.forEach((item, index) => {
        if (item.group !== group) {
            group = item.group;
            rows.push(<li role="presentation" className="pal-g" key={'group-' + group}>{PALETTE_GROUPS[group]}</li>);
        }
        const selected = index === activeIndex;
        rows.push(
            <li
                role="option"
                id={optionId(index)}
                className="pal-o"
                aria-selected={selected}
                key={item.id}
                onClick={() => run(item)}
                onMouseMove={() => setActive(index)}
            >
                <Icon name={item.icon} />
                <span className="pl">{item.label}</span>
                {item.hint && <span className="ps">{item.hint}</span>}
                {selected && <kbd aria-hidden="true">↵</kbd>}
            </li>
        );
    });

    // The close event arrives a task later, possibly after a quick reopen.
    function closed() {
        if (!ref.current.open) {
            close();
        }
    }

    return (
        <dialog ref={ref} className="palette" aria-label="Command palette" onClose={closed}>
            <div className="pal-in">
                <Icon name="search" />
                <label className="visually-hidden" htmlFor="palette-input">Search contacts or run a command</label>
                <input
                    id="palette-input"
                    role="combobox"
                    aria-expanded="true"
                    aria-controls="palette-list"
                    aria-autocomplete="list"
                    aria-activedescendant={items.length ? optionId(activeIndex) : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Search contacts or type a command…"
                    value={input}
                    onChange={(event) => {
                        setInput(event.currentTarget.value);
                        setActive(0);
                    }}
                    onKeyDown={keyDown}
                />
                <kbd>Esc</kbd>
            </div>
            <ul className="pal-list" id="palette-list" role="listbox" aria-label="Results">{rows}</ul>
            {!items.length && <p className="pal-empty">No matches for "{input.trim()}".</p>}
            <div className="pal-foot">
                <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
                <span><kbd>↵</kbd> run</span>
                <span><kbd>Esc</kbd> close</span>
                <span className="sp" />
                <span>Try "call nina" or "pipeline"</span>
            </div>
        </dialog>
    );
}
