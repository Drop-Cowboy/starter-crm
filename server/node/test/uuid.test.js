import { describe, expect, it } from 'vitest';
import { UUID_PATTERN, uuidv5 } from '../src/uuid.js';
import { VECTORS } from './vectors.js';

describe('uuidv5', () => {
    for (const vector of VECTORS.uuidv5) {
        it('matches the reference vector for "' + vector.name + '"', () => {
            expect(uuidv5(vector.namespace, vector.name)).toBe(vector.expect);
        });
    }

    it('always produces a version 5, RFC 4122 variant UUID', () => {
        const id = uuidv5('3f8a2c1e-9b4d-4e7a-8c2f-1d5e6a7b8c9d', 'anything');
        expect(id).toMatch(UUID_PATTERN);
        expect(id[14]).toBe('5');
        expect('89ab').toContain(id[19]);
    });
});
