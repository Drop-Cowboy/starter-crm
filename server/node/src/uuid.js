/**
 * UUID helpers: the version 5 (name-based) UUIDs the starter derives user ids from.
 *
 * Where it sits: the oidc identity maps an external subject that is not a
 * UUID, and the passcode identity names its one owner, with `uuidv5()`.
 * Drop Cowboy needs a UUID `sub`, and v5 is stateless and deterministic, so
 * the same person gets the same id on every server and every restart. The
 * Python server computes the same values (`starter_crm/uuid5.py`).
 *
 * CONTRACT.md: "The `oidc` identity".
 * What a customer changes: nothing.
 */

import crypto from 'node:crypto';

/** Matches a UUID of any version. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * RFC 4122 UUID version 5: SHA-1 over the namespace bytes then the name.
 *
 * @param {string} namespace A UUID, such as `DROPCOWBOY_SITE_ID`.
 * @param {string} name The text to derive an id from.
 * @returns {string} A lower-case UUID.
 */
export function uuidv5(namespace, name) {
    const bytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
    const hash = crypto.createHash('sha1').update(bytes).update(name, 'utf8').digest().subarray(0, 16);
    // Version 5 in the high nibble of byte 6; the RFC 4122 variant in byte 8.
    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.toString('hex');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
