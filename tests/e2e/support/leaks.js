// Where a token must never show up in the browser: the page itself (including
// widgets' shadow roots and form values), any URL the page requests, browser
// storage, and the console. Tokens belong in memory and in Authorization
// headers, nowhere else.

// Any JWT: three base64url parts, the first two JSON objects ("eyJ" is "{").
export const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}/;

/** Everything a page shows or stores, as plain strings. */
export async function readPage(page) {
    return page.evaluate(() => {
        const text = [document.documentElement.outerHTML];
        const visit = (root) => {
            for (const el of root.querySelectorAll('*')) {
                if (typeof el.value === 'string' && el.value) {
                    text.push(el.value);
                }
                if (el.shadowRoot) {
                    text.push(el.shadowRoot.innerHTML);
                    visit(el.shadowRoot);
                }
            }
        };
        visit(document);
        const storage = (store) => Object.fromEntries(Object.keys(store).map((key) => [key, store.getItem(key)]));
        return {
            url: location.href,
            dom: text.join('\n'),
            localStorage: storage(localStorage),
            sessionStorage: storage(sessionStorage),
            cookies: document.cookie
        };
    });
}

/**
 * Names each place in `haystacks` that holds a JWT or one of `secrets`.
 * @param {Record<string, string>} haystacks  label -> text
 * @param {string[]} secrets
 */
export function findLeaks(haystacks, secrets) {
    const leaks = [];
    for (const [label, text] of Object.entries(haystacks)) {
        if (!text) continue;
        if (JWT_PATTERN.test(text)) {
            leaks.push(label + ' contains a JWT');
            continue;
        }
        if (secrets.some((secret) => secret && text.includes(secret))) {
            leaks.push(label + ' contains a secret');
        }
    }
    return leaks;
}
