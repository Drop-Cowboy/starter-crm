import { readFileSync } from 'node:fs';

/** The vectors shared with the Python implementation (server/conformance/provider/vectors.json). */
export const VECTORS = JSON.parse(readFileSync(new URL('../../conformance/provider/vectors.json', import.meta.url), 'utf8'));
