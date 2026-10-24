/**
 * A small JSON Schema checker for request bodies.
 *
 * Where it sits: a module route names a schema (`router.post('/', { body: schema }, handler)`)
 * and modules.js calls `checkBody()` before the handler runs, so a handler only ever sees
 * input that already fits. The schemas are plain JSON files in `server/schemas/`, shared with
 * the Python server (`starter_crm/validate.py`), and a conformance vector file
 * (`server/conformance/provider/schema-vectors.json`) keeps the two checkers saying the same
 * thing in the same words.
 *
 * Only the keywords a request body needs are supported: `type` (one name or a list), `properties`,
 * `required`, `additionalProperties` (false only), `enum`, `minLength`, `maxLength`, `minimum`,
 * `maximum`, `pattern`, `format` (`uuid` only), `items`, `maxItems` and `minProperties`. A `pattern` must match the
 * whole string (the checker anchors it) and should stick to plain character classes such as `[A-Z]{3}`, which mean
 * the same in JavaScript and Python. Anything
 * else is a mistake in the schema and throws when the schema is loaded, not when a user posts.
 *
 * The first problem found is reported, as `<field>: <what is wrong>`, so a form can show it next
 * to the right input. A field inside an object is `parent.child`; inside a list, `parent[0]`.
 *
 * CONTRACT.md: "Modules" (Input validation).
 * What a customer changes: nothing; write a schema file and name it in your route.
 */

import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './errors.js';

/** The keywords this checker understands; any other is rejected so a typo cannot silently allow bad input. */
const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'enum', 'minLength', 'maxLength',
    'minimum', 'maximum', 'pattern', 'format', 'items', 'maxItems', 'minProperties', 'description', '$comment']);

/** The type names a schema may use. */
const TYPES = new Set(['object', 'string', 'integer', 'number', 'boolean', 'array', 'null']);

/** How each type is written in a message: "must be a string", "must be an integer". */
const TYPE_PHRASES = Object.freeze({
    object: 'an object', string: 'a string', integer: 'an integer', number: 'a number', boolean: 'a boolean', array: 'an array', null: 'null'
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where the schema files live: `server/schemas`, two folders above this file's `server/node/src`. */
const SCHEMAS_DIR = path.resolve(import.meta.dirname, '..', '..', 'schemas');

/**
 * Whether a value is a JSON object (not null, not a list).
 *
 * @param {unknown} value Anything.
 * @returns {boolean} True for a plain object.
 */
function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The JSON type names a value has: an integer is also a number.
 *
 * @param {unknown} value Anything parsed from JSON.
 * @returns {string[]} Every type name that fits.
 */
function typesOf(value) {
    if (value === null) return ['null'];
    if (Array.isArray(value)) return ['array'];
    if (typeof value === 'number') return Number.isInteger(value) ? ['integer', 'number'] : ['number'];
    if (typeof value === 'object') return ['object'];
    return [typeof value];
}

/**
 * Reads a schema file and checks it only uses supported keywords.
 *
 * @param {string} name The file name without `.json`, such as `deals`.
 * @returns {Record<string, object>} The file's schemas by name (for Deals: `create` and `update`).
 * @throws {Error} When the file is missing, is not JSON, or uses a keyword this checker does not support.
 */
export function loadSchemas(name) {
    const file = path.join(SCHEMAS_DIR, name + '.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const schemas = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (key.startsWith('$')) continue;
        assertSupported(value, name + '.' + key);
        schemas[key] = value;
    }
    return schemas;
}

/**
 * Walks a schema and throws on any keyword the checker does not implement.
 *
 * @param {object} schema The schema to check.
 * @param {string} where Where it is, for the error message.
 * @returns {void}
 * @throws {Error} Naming the unsupported keyword and where it is.
 */
export function assertSupported(schema, where) {
    if (!isObject(schema)) throw new Error('schema ' + where + ' must be an object');
    for (const key of Object.keys(schema)) {
        if (!KEYWORDS.has(key)) throw new Error('schema ' + where + ' uses "' + key + '", which this checker does not support');
    }
    const types = schema.type === undefined ? [] : [].concat(schema.type);
    for (const type of types) {
        if (!TYPES.has(type)) throw new Error('schema ' + where + ' has an unknown type "' + type + '"');
    }
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
        throw new Error('schema ' + where + ': additionalProperties may only be false');
    }
    if (schema.format !== undefined && schema.format !== 'uuid') {
        throw new Error('schema ' + where + ' has an unsupported format "' + schema.format + '"');
    }
    for (const [key, child] of Object.entries(schema.properties || {})) assertSupported(child, where + '.' + key);
    if (schema.items !== undefined) assertSupported(schema.items, where + '[]');
}

/**
 * Finds the first thing wrong with a value, or null when it fits the schema.
 *
 * @param {object} schema A schema from `loadSchemas()`.
 * @param {unknown} value The parsed request body.
 * @param {string} [at] The field name so far; empty for the body itself.
 * @returns {string|null} A message such as `title: must be at least 1 character`, or null.
 */
export function firstProblem(schema, value, at = '') {
    const label = at === '' ? 'body' : at;
    if (schema.type !== undefined) {
        const wanted = [].concat(schema.type);
        const have = typesOf(value);
        if (!wanted.some((type) => have.includes(type))) {
            return label + ': must be ' + wanted.map((type) => TYPE_PHRASES[type]).join(' or ');
        }
    }
    if (schema.enum !== undefined && !schema.enum.includes(value)) {
        return label + ': must be one of ' + schema.enum.join(', ');
    }
    if (typeof value === 'string') {
        // Length is counted in characters (code points), the same way the Python server counts.
        const length = [...value].length;
        if (schema.minLength !== undefined && length < schema.minLength) {
            return label + ': must be at least ' + schema.minLength + (schema.minLength === 1 ? ' character' : ' characters');
        }
        if (schema.maxLength !== undefined && length > schema.maxLength) {
            return label + ': must be at most ' + schema.maxLength + (schema.maxLength === 1 ? ' character' : ' characters');
        }
        if (schema.format === 'uuid' && !UUID.test(value)) return label + ': must be a UUID';
        if (schema.pattern !== undefined && !new RegExp('^(?:' + schema.pattern + ')$').test(value)) return label + ': has the wrong format';
    }
    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) return label + ': must be at least ' + schema.minimum;
        if (schema.maximum !== undefined && value > schema.maximum) return label + ': must be at most ' + schema.maximum;
    }
    if (Array.isArray(value)) return arrayProblem(schema, value, label);
    if (isObject(value)) return objectProblem(schema, value, at);
    return null;
}

/**
 * Checks a list against `maxItems` and `items`.
 *
 * @param {object} schema The schema for the list.
 * @param {unknown[]} value The list.
 * @param {string} label The field name, for messages.
 * @returns {string|null} The first problem, or null.
 */
function arrayProblem(schema, value, label) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return label + ': must have at most ' + schema.maxItems + (schema.maxItems === 1 ? ' item' : ' items');
    if (schema.items === undefined) return null;
    for (let i = 0; i < value.length; i++) {
        const found = firstProblem(schema.items, value[i], label + '[' + i + ']');
        if (found) return found;
    }
    return null;
}

/**
 * Checks an object against `minProperties`, `required`, `additionalProperties` and `properties`.
 *
 * @param {object} schema The schema for the object.
 * @param {object} value The object.
 * @param {string} at The field name so far; empty for the body itself.
 * @returns {string|null} The first problem, or null.
 */
function objectProblem(schema, value, at) {
    const join = (key) => (at === '' ? key : at + '.' + key);
    const label = at === '' ? 'body' : at;
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
        if (!Object.hasOwn(value, key)) return join(key) + ': is required';
    }
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
        return label + ': must have at least ' + schema.minProperties + (schema.minProperties === 1 ? ' field' : ' fields');
    }
    // Declaration order first, so the message does not depend on the order the caller sent the keys.
    for (const key of Object.keys(properties)) {
        if (!Object.hasOwn(value, key)) continue;
        const found = firstProblem(properties[key], value[key], join(key));
        if (found) return found;
    }
    if (schema.additionalProperties === false) {
        const extra = Object.keys(value).filter((key) => !Object.hasOwn(properties, key)).sort()[0];
        if (extra !== undefined) return join(extra) + ': is not allowed';
    }
    return null;
}

/**
 * Throws 400 `invalid_request` when a request body does not fit its schema.
 *
 * @param {object} schema A schema from `loadSchemas()`.
 * @param {unknown} body The parsed JSON body.
 * @returns {void}
 * @throws {HttpError} 400 `invalid_request`, with the field and the problem in the message.
 */
export function checkBody(schema, body) {
    const found = firstProblem(schema, body);
    if (found) throw new HttpError(400, 'invalid_request', found + '.');
}
