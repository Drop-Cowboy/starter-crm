import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { contactInitials } from '../format.js';
import {
    iconHref,
    isCurrentPath,
    isPaletteShortcut,
    paletteItems,
    parsePaletteInput,
    readLayout,
    showsContactList,
    syncWidgetTheme
} from '../ui.js';

const NINA = { id: 'b5e20c97-4d13-4a6f-8e7b-f09c3a21d6e4', first_name: 'Nina', last_name: 'Park', main_phone: '+15125550183', company: 'Parkside Clinic' };
const OWEN = { id: '6f3b9d24-0e7a-4c81-95b6-2a1f8e7d4c30', first_name: 'Owen', last_name: 'Diaz', email: 'owen@example.com' };

function fakeRoot() {
    const attrs = {};
    return {
        getAttribute: (name) => (name in attrs ? attrs[name] : null),
        setAttribute: (name, value) => { attrs[name] = value; },
        attrs
    };
}

function fakeMedia(matches) {
    const listeners = new Set();
    const query = {
        matches,
        addEventListener: (type, fn) => listeners.add(fn),
        removeEventListener: (type, fn) => listeners.delete(fn)
    };
    return {
        matchMedia: () => query,
        flip(next) {
            query.matches = next;
            for (const fn of listeners) {
                fn();
            }
        },
        listeners
    };
}

describe('navigation helpers', () => {
    it('marks the current page, with / as Contacts', () => {
        assert.equal(isCurrentPath('/contacts/' + NINA.id, '/contacts'), true);
        assert.equal(isCurrentPath('/', '/contacts'), true);
        assert.equal(isCurrentPath('/contactsx', '/contacts'), false);
        assert.equal(isCurrentPath('/pipeline', '/contacts'), false);
    });

    it('shows the contact list only on contact pages', () => {
        assert.equal(showsContactList('/contacts'), true);
        assert.equal(showsContactList('/contacts/new'), true);
        assert.equal(showsContactList('/'), true);
        assert.equal(showsContactList('/pipeline'), false);
    });

    it('reads the embedded layout from the query string only', () => {
        assert.equal(readLayout('?layout=embedded'), 'embedded');
        assert.equal(readLayout('?layout=full'), 'full');
        assert.equal(readLayout(''), 'full');
    });

    it('points icons at the shared sprite', () => {
        assert.equal(iconHref('users'), '/shared/icons.svg#i-users');
    });

    it('opens the palette on Cmd+K and Ctrl+K only', () => {
        assert.equal(isPaletteShortcut({ metaKey: true, key: 'k' }), true);
        assert.equal(isPaletteShortcut({ ctrlKey: true, key: 'K' }), true);
        assert.equal(isPaletteShortcut({ key: 'k' }), false);
        assert.equal(isPaletteShortcut({ ctrlKey: true, shiftKey: true, key: 'k' }), false);
    });
});

describe('initials', () => {
    it('uses first and last name, else the first letter of the display name', () => {
        assert.equal(contactInitials(NINA), 'NP');
        assert.equal(contactInitials({ email: 'dana@example.com' }), 'D');
        assert.equal(contactInitials({ main_phone: '+15125550100' }), '5');
        assert.equal(contactInitials({}), 'U');
    });
});

describe('widget theme', () => {
    it('follows the system setting and keeps following it', () => {
        const root = fakeRoot();
        const media = fakeMedia(false);
        const stop = syncWidgetTheme(root, media.matchMedia);
        assert.equal(root.attrs['data-dc-theme'], 'light');
        media.flip(true);
        assert.equal(root.attrs['data-dc-theme'], 'dark');
        stop();
        assert.equal(media.listeners.size, 0);
    });

    it('lets data-theme on the root override the system setting', () => {
        const root = fakeRoot();
        root.setAttribute('data-theme', 'dark');
        syncWidgetTheme(root, fakeMedia(false).matchMedia);
        assert.equal(root.attrs['data-dc-theme'], 'dark');
    });
});

describe('command palette', () => {
    it('splits a leading verb from the search text', () => {
        assert.deepEqual(parsePaletteInput('call nina'), { verb: 'call', rest: 'nina' });
        assert.deepEqual(parsePaletteInput('  Text  nina park '), { verb: 'text', rest: 'nina park' });
        assert.deepEqual(parsePaletteInput('nina'), { verb: '', rest: 'nina' });
        assert.deepEqual(parsePaletteInput('callnina'), { verb: '', rest: 'callnina' });
    });

    it('lists matching contacts, actions on the first one, then matching pages', () => {
        const items = paletteItems({ input: 'nina', contacts: [NINA] });
        assert.deepEqual(items.map((i) => i.id), ['contact:' + NINA.id, 'call:' + NINA.id, 'text:' + NINA.id]);
        assert.deepEqual(items[0].action, { type: 'navigate', path: '/contacts/' + NINA.id });
    });

    it('hands calls and texts the whole contact, so the Dock gets contact_id', () => {
        const [call] = paletteItems({ input: 'call nina', contacts: [NINA, OWEN] });
        assert.equal(call.action.type, 'call');
        assert.equal(call.action.contact.id, NINA.id);
        const texts = paletteItems({ input: 'text o', contacts: [OWEN] });
        assert.deepEqual(texts, [], 'a contact with no phone cannot be texted');
    });

    it('finds pages by name, and lists every page when empty', () => {
        assert.deepEqual(paletteItems({ input: 'pipe', contacts: [] }).map((i) => i.action.path), ['/pipeline']);
        assert.deepEqual(paletteItems({ input: 'go set', contacts: [NINA] }).map((i) => i.action.path), ['/setup']);
        const all = paletteItems({ input: '', contacts: [] });
        assert.equal(all.length, 7);
        assert.equal(all.at(-1).action.path, '/contacts/new');
    });
});
