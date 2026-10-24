import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/errors.js';
import { assertSupported, checkBody, firstProblem, loadSchemas } from '../src/validate.js';

const VECTORS = JSON.parse(readFileSync(new URL('../../conformance/provider/schema-vectors.json', import.meta.url), 'utf8'));

describe('request-body schemas (shared with the Python server)', () => {
    it.each(VECTORS.cases.map((c) => [c.name, c]))('%s', (_name, entry) => {
        expect(firstProblem(entry.schema, entry.value)).toEqual(entry.problem);
    });
});

describe('checkBody', () => {
    it('answers 400 invalid_request with the problem and a full stop', () => {
        const schema = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } };
        let thrown;
        try {
            checkBody(schema, {});
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(HttpError);
        expect(thrown.status).toBe(400);
        expect(thrown.code).toBe('invalid_request');
        expect(thrown.message).toBe('title: is required.');
    });

    it('accepts a body that fits', () => {
        expect(() => checkBody({ type: 'object' }, {})).not.toThrow();
    });
});

describe('schema files', () => {
    it('loads the Deals schemas and every keyword in them is supported', () => {
        const schemas = loadSchemas('deals');
        expect(Object.keys(schemas).sort()).toEqual(['create', 'query', 'update']);
    });

    it('refuses a keyword the checker does not implement, so a schema never silently does nothing', () => {
        expect(() => assertSupported({ type: 'object', oneOf: [] }, 'x')).toThrow(/oneOf/);
        expect(() => assertSupported({ type: 'object', properties: { a: { type: 'string', format: 'email' } } }, 'x')).toThrow();
    });
});
