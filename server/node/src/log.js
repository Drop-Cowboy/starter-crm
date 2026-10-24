/**
 * The redacting logger: every record passes through redact(), so a stray log
 * of a request or an error can never leak a secret, a token, a phone number
 * or an email address.
 *
 * Where it sits: bootstrap.js builds one logger from the config and a log
 * sink (the `console` provider, or your own), and the core hands each request
 * a child logger tagged with its request id. Redaction happens here, before
 * the sink, so it applies to custom sinks too.
 *
 * CONTRACT.md: "Logging" (secrets and tokens never appear in output).
 * What a customer changes: nothing. Keep using it for every log line.
 */

import { secretValues } from './config.js';

// Anything shaped like a JWT, which is what a site token is.
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
// A bearer credential, such as a login-mode access token, JWT-shaped or not.
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
// An email address. Contacts' emails must not end up in log storage.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// A phone number: 10 digits as 3-3-4 with common separators and an optional
// parenthesised area code, with an optional country code in front. A country
// code needs a leading "+" or a separator after it, and the match must not start
// inside a longer word or run into more digits, so a 13-digit epoch-millisecond
// timestamp is left alone.
const PHONE = /(?<!\w)(?:\+\d{1,3}[\s.-]?|\d{1,3}[\s.-])?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
// A UUID, matched in the same pass so it is kept whole: a last segment that
// starts with 10 digits, as about one in a hundred do, otherwise looks like a
// phone number, and a request id must survive to be searchable.
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;
const UUID_OR_PHONE = new RegExp('(' + UUID.source + ')|' + PHONE.source, 'gi');

/** Shortest configured secret that is redacted: shorter strings would mangle ordinary words if someone chose a trivial secret. */
const MIN_SECRET_LENGTH = 4;

/**
 * Replaces secrets, bearer credentials, JWT-shaped tokens, email addresses
 * and phone numbers with markers.
 *
 * @param {string} text The text to clean.
 * @param {string[]} secrets Exact secret values to remove.
 * @returns {string} The text with every match replaced.
 */
export function redact(text, secrets) {
    let out = String(text);
    for (const secret of secrets) {
        if (secret && secret.length >= MIN_SECRET_LENGTH) {
            out = out.split(secret).join('[redacted]');
        }
    }
    return out
        .replace(BEARER, 'Bearer [redacted]')
        .replace(JWT, '[redacted-token]')
        .replace(EMAIL, '[redacted-email]')
        .replace(UUID_OR_PHONE, (match, uuid) => (uuid ? match : '[redacted-phone]'));
}

/**
 * Redacts every string inside a value, however deeply it is nested.
 *
 * @param {unknown} value A log field.
 * @param {string[]} secrets Exact secret values to remove.
 * @param {number} [depth] Recursion guard against cycles.
 * @returns {unknown} A copy with every string cleaned.
 */
function redactValue(value, secrets, depth = 0) {
    if (typeof value === 'string') return redact(value, secrets);
    if (value === null || typeof value !== 'object' || depth > 5) return value;
    if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, depth + 1));
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactValue(item, secrets, depth + 1);
    return out;
}

/**
 * Turns log arguments into one message string.
 *
 * @param {unknown} value One argument.
 * @returns {string} Its text.
 */
function stringify(value) {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
}

/**
 * Adapts a console-like object (`log`, `warn`, `error`) to the sink shape.
 *
 * @param {{ log: Function, warn: Function, error: Function }} target The console or a test double.
 * @param {string} format `pretty` or `json`.
 * @returns {{ write: (record: object) => void }} A sink.
 */
export function consoleSink(target, format) {
    return {
        write(record) {
            const line = format === 'json' ? JSON.stringify(record) : record.message;
            if (record.level === 'error') target.error(line);
            else if (record.level === 'warn') target.warn(line);
            else target.log(line);
        }
    };
}

/**
 * Builds a logger that scrubs secrets, tokens, phone numbers and emails from every record.
 *
 * @param {object} config The loaded config; its secrets are read on every call, so refreshed ones are covered.
 * @param {{ write: Function }|{ log: Function, warn: Function, error: Function }} [sink] Where records go.
 *   A `write(record)` sink (a log provider) gets the redacted record; a console-like object gets one line.
 * @param {{ format?: string }} [options] `format` is `pretty` or `json` for a console-like sink;
 *   it defaults to the config's `logFormat`.
 * @returns {{ info: Function, warn: Function, error: Function, access: Function, child: Function }} The logger.
 *   Every writing method returns a promise that callers must await. `access(fields)` writes one
 *   request line; `child(fields)` returns a logger that adds `fields` to every record.
 */
export function createLogger(config, sink = console, options = {}) {
    const target = typeof sink.write === 'function'
        ? sink
        : consoleSink(sink, options.format || config.logFormat || 'pretty');

    function build(bound) {
        const emit = async (level, message, fields) => {
            const secrets = secretValues(config);
            const record = { time: new Date().toISOString(), level, message: redact(message, secrets) };
            for (const [key, value] of Object.entries(bound)) record[key] = redactValue(value, secrets);
            for (const [key, value] of Object.entries(fields)) record[key] = redactValue(value, secrets);
            // A sink that fails must not take a request down with it, but it is
            // always awaited: a log line still in flight when a serverless host
            // freezes the process would be lost.
            try {
                await target.write(record);
            } catch {
                // Nothing safe left to report to.
            }
        };
        const say = (level) => (...args) => emit(level, args.map(stringify).join(' '), {});
        return {
            info: say('info'),
            warn: say('warn'),
            error: say('error'),
            access(fields) {
                return emit('info', fields.method + ' ' + fields.path + ' ' + fields.status + ' ' + fields.duration_ms + 'ms', fields);
            },
            child(fields) {
                return build({ ...bound, ...fields });
            }
        };
    }
    return build({});
}
