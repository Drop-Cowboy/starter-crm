// The custom providers the harness hands to the server under test. They are
// written in the server's own language (SERVER_LANG), because a Node server
// cannot load a Python provider and the reverse. Each does one small thing the
// suites can observe from outside.

/**
 * The file extension a provider has in `lang`.
 *
 * @param {'node'|'python'} lang The server language.
 * @returns {string} `js` or `py`.
 */
export function extension(lang) {
    return lang === 'python' ? 'py' : 'js';
}

/**
 * Source for an identity that signs in whoever sends `X-Test-User`.
 *
 * @param {'node'|'python'} lang The server language.
 * @returns {string} The provider module source.
 */
export function identitySource(lang) {
    if (lang === 'python') {
        return `"""Conformance identity: whoever sends X-Test-User is signed in as that id."""

name = "conformance-identity"
config_keys = []


def validate(env):
    return []


class Identity:
    def authenticate(self, request):
        user_id = request.headers.get("x-test-user")
        if not user_id:
            return None
        return {"id": user_id, "email": "tester@example.com"}


def create(ctx):
    return Identity()
`;
    }
    return `export const name = 'conformance-identity';
export const configKeys = [];
export function validate() { return []; }
export function create() {
    return {
        async authenticate(request) {
            const id = request.headers.get('x-test-user');
            return id ? { id, email: 'tester@example.com' } : null;
        }
    };
}
`;
}

/**
 * Source for a log sink that appends each record to `file` as one JSON line.
 *
 * @param {'node'|'python'} lang The server language.
 * @param {string} file Absolute path of the JSON-lines file.
 * @returns {string} The provider module source.
 */
export function logSource(lang, file) {
    if (lang === 'python') {
        return `"""Conformance log sink: appends each record to a JSON-lines file."""
import json

name = "conformance-log"
config_keys = []


def validate(env):
    return []


class Sink:
    def write(self, record):
        with open(${JSON.stringify(file)}, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record) + "\\n")


def create(ctx):
    return Sink()
`;
    }
    return `import { appendFileSync } from 'node:fs';
export const name = 'conformance-log';
export const configKeys = [];
export function validate() { return []; }
export function create() {
    return { async write(record) { appendFileSync(${JSON.stringify(file)}, JSON.stringify(record) + '\\n'); } };
}
`;
}

/**
 * Source for an observer that records every hook, and throws from `onWebhook`
 * after recording, to prove a failing hook cannot change a response.
 *
 * @param {'node'|'python'} lang The server language.
 * @param {string} file Absolute path of the JSON-lines file.
 * @returns {string} The provider module source.
 */
export function observerSource(lang, file) {
    if (lang === 'python') {
        return `"""Conformance observer: records each hook; on_webhook raises after recording."""
import json

name = "conformance-observer"
config_keys = []


def validate(env):
    return []


def _record(hook, payload):
    with open(${JSON.stringify(file)}, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"hook": hook, "payload": payload}) + "\\n")


class Observer:
    def on_request(self, payload):
        _record("onRequest", payload)

    def on_response(self, payload):
        _record("onResponse", payload)

    def on_error(self, payload):
        _record("onError", payload)

    def on_webhook(self, payload):
        _record("onWebhook", payload)
        raise RuntimeError("observer failure that must not change the response")

    def on_token_minted(self, payload):
        _record("onTokenMinted", payload)


def create(ctx):
    return Observer()
`;
    }
    return `import { appendFileSync } from 'node:fs';
const record = (hook, payload) => appendFileSync(${JSON.stringify(file)}, JSON.stringify({ hook, payload }) + '\\n');
export const name = 'conformance-observer';
export const configKeys = [];
export function validate() { return []; }
export function create() {
    return {
        async onRequest(payload) { record('onRequest', payload); },
        async onResponse(payload) { record('onResponse', payload); },
        async onError(payload) { record('onError', payload); },
        async onWebhook(payload) { record('onWebhook', payload); throw new Error('observer failure that must not change the response'); },
        async onTokenMinted(payload) { record('onTokenMinted', payload); }
    };
}
`;
}

/**
 * Source for a secrets provider that serves the JSON object in `file`, read
 * fresh on every load and refresh, so a test can rotate a secret by rewriting it.
 *
 * @param {'node'|'python'} lang The server language.
 * @param {string} file Absolute path of the JSON file.
 * @returns {string} The provider module source.
 */
export function secretsSource(lang, file) {
    if (lang === 'python') {
        return `"""Conformance secrets: serves a JSON file, re-read on every load and refresh."""
import json

name = "conformance-secrets"
config_keys = []


def validate(env):
    return []


class Secrets:
    def _read(self):
        with open(${JSON.stringify(file)}, encoding="utf-8") as handle:
            return json.load(handle)

    def load(self, names):
        values = self._read()
        return {key: values[key] for key in names if key in values}

    def refresh(self):
        return self._read()


def create(ctx):
    return Secrets()
`;
    }
    return `import { readFileSync } from 'node:fs';
const read = () => JSON.parse(readFileSync(${JSON.stringify(file)}, 'utf8'));
export const name = 'conformance-secrets';
export const configKeys = [];
export function validate() { return []; }
export function create() {
    return {
        async load(names) {
            const values = read();
            const out = {};
            for (const key of names) if (key in values) out[key] = values[key];
            return out;
        },
        async refresh() { return read(); }
    };
}
`;
}
