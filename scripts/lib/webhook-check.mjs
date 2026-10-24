/**
 * What `npm run doctor` reads about this server's webhook, kept apart from doctor.mjs so it can be tested.
 *
 * Where it sits: doctor.mjs lists the account's webhooks (`GET /register/public/webhooks`)
 * and asks this file whether one of them points here and whether Drop Cowboy has switched it off.
 *
 * Drop Cowboy documents pausing a failing origin, not a "disabled" flag on the webhook, so the
 * disabled check reads the fields such a flag would use and stays quiet when there are none.
 */

const OFF_STATUSES = ['disabled', 'paused', 'suspended', 'inactive'];

/**
 * Pulls the webhook list out of the API's answer, which is an array or `{ data: [...] }`.
 *
 * @param {unknown} body The parsed response.
 * @returns {object[]} The webhooks (empty when the shape is unfamiliar).
 */
export function webhooksOf(body) {
    const list = Array.isArray(body) ? body : body && Array.isArray(body.data) ? body.data : [];
    return list.filter((item) => item && typeof item === 'object');
}

/**
 * Whether a webhook carries a sign that Drop Cowboy stopped sending to it.
 *
 * @param {object} webhook One item of the list.
 * @returns {boolean} True when it says it is disabled, paused, inactive or not enabled.
 */
export function looksSwitchedOff(webhook) {
    if (webhook.disabled === true || webhook.paused === true) return true;
    if (webhook.enabled === false || webhook.is_active === false || webhook.active === false) return true;
    return typeof webhook.status === 'string' && OFF_STATUSES.includes(webhook.status.toLowerCase());
}

/**
 * Finds this server's webhook among the account's and judges it.
 *
 * @param {object[]} webhooks The account's webhooks.
 * @param {string | null | undefined} publicUrl `DC_PUBLIC_URL`, the address Drop Cowboy should call.
 * @returns {{ state: 'unknown' | 'missing' | 'switched_off' | 'ok', message: string }} The verdict.
 */
export function judgeRegistration(webhooks, publicUrl) {
    if (!publicUrl) {
        return { state: 'unknown', message: 'DC_PUBLIC_URL is not set, so doctor cannot tell which webhook is this server\'s.' };
    }
    const target = publicUrl.replace(/\/+$/, '') + '/webhooks/dropcowboy';
    const mine = webhooks.filter((item) => typeof item.hook_url === 'string' && item.hook_url.replace(/\/+$/, '') === target);
    if (mine.length === 0) {
        return { state: 'missing', message: 'no webhook on this account points at ' + target + '. Create one: docs/webhooks.md, "Step 2: create the webhook".' };
    }
    if (mine.every(looksSwitchedOff)) {
        return {
            state: 'switched_off',
            message: 'Drop Cowboy has switched off the webhook for ' + target + ' after repeated failures. '
                + 'Fix the cause (npm run webhooks:failed), then re-enable it in the dashboard. Events sent meanwhile were not queued.'
        };
    }
    return { state: 'ok', message: 'the webhook for ' + target + ' is registered' };
}
