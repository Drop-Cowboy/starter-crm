import { secretValues } from './config.js';

// Anything shaped like a JWT, which is what a site token is.
const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
// A bearer credential, such as a login-mode access token, JWT-shaped or not.
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

export function redact(text, secrets) {
    let out = String(text);
    for (const secret of secrets) {
        if (secret && secret.length >= 4) {
            out = out.split(secret).join('[redacted]');
        }
    }
    return out.replace(BEARER, 'Bearer [redacted]').replace(JWT, '[redacted-token]');
}

// A console logger that scrubs secrets and tokens from every line, so a stray
// log of a request or an error can never leak them.
export function createLogger(config, sink = console) {
    const secrets = secretValues(config);
    const format = (args) => redact(args.map(stringify).join(' '), secrets);
    return {
        info: (...args) => sink.log(format(args)),
        warn: (...args) => sink.warn(format(args)),
        error: (...args) => sink.error(format(args))
    };
}

function stringify(value) {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
}
