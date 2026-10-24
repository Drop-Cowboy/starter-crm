/**
 * An in-memory cache of minted site tokens, one per user and purpose.
 *
 * Where it sits: the token route asks the cache before calling Drop Cowboy, in
 * `server` mode only. A page load asks for a token, a dialer asks again a minute
 * later, and tabs multiply that; without a cache every one of those is a mint
 * against your API key and a slot in the per-user limit.
 *
 * Why a 60 second margin: a token with less than a minute left could expire
 * before the browser uses it, so it is treated as already gone. A cached token
 * is never shared across users (the key includes the user id), never logged,
 * and never written anywhere but this process's memory.
 *
 * CONTRACT.md: "Calling Drop Cowboy carefully".
 * Env: DC_TOKEN_CACHE (on by default).
 * What a customer changes: nothing.
 */

/** A cached token must have more than this long left to be served again. */
export const CACHE_MARGIN_MS = 60 * 1000;

/** The most entries kept; beyond it the oldest go, so a flood of distinct users cannot exhaust memory. */
const MAX_ENTRIES = 1000;

/**
 * Creates a cache.
 *
 * @param {() => number} [now] Clock in epoch milliseconds, replaceable in tests.
 * @returns {{ get: (key: string) => { token: string, expires_at: number }|null,
 *   set: (key: string, entry: { token: string, expires_at: number }) => void }} The cache.
 */
export function createTokenCache(now = Date.now) {
    const entries = new Map();

    function usable(entry) {
        return entry.expires_at - now() > CACHE_MARGIN_MS;
    }

    return {
        get(key) {
            const entry = entries.get(key);
            if (!entry) return null;
            if (!usable(entry)) {
                entries.delete(key);
                return null;
            }
            return entry;
        },
        set(key, entry) {
            if (!usable(entry)) return;
            entries.delete(key);
            entries.set(key, { token: entry.token, expires_at: entry.expires_at });
            // Map iterates in insertion order, so the first key is the oldest.
            while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
        }
    };
}
