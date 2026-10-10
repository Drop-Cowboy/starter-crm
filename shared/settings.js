import { toE164 } from './format.js';

// Preferences this browser remembers. Only harmless values live in
// localStorage: never a token, a sign-in, or anything from /api/config.

const BUSINESS_NUMBER_KEY = 'starter-crm.business-number';

/**
 * The number texts are sent from, as E.164, or '' when not chosen yet.
 * Texting needs a number on your account that is registered for texting.
 */
export function getBusinessNumber(storage) {
    const store = storage || globalThis.localStorage;
    return toE164(store.getItem(BUSINESS_NUMBER_KEY) || '');
}

/** Saves the number and returns it as E.164, or '' when it is not a phone number. */
export function setBusinessNumber(value, storage) {
    const store = storage || globalThis.localStorage;
    const number = toE164(value);
    if (number) {
        store.setItem(BUSINESS_NUMBER_KEY, number);
    } else {
        store.removeItem(BUSINESS_NUMBER_KEY);
    }
    return number;
}
