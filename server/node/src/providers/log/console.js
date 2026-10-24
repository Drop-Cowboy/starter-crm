/**
 * The `console` log provider: records go to stdout (info) and stderr (warn, error).
 *
 * Where it sits: the default (`DC_LOG=console`). `DC_LOG_FORMAT=json` writes
 * one JSON object per line, which every log service understands;
 * `pretty` writes just the message, for a terminal. Redaction has already run
 * by the time a record gets here.
 *
 * CONTRACT.md: "Logging".
 * What a customer changes: nothing; set `DC_LOG` to your own provider to ship
 * records elsewhere.
 */

import { consoleSink } from '../../log.js';

export const name = 'console';
export const configKeys = [];

/**
 * Nothing to configure.
 *
 * @returns {object[]} No problems.
 */
export function validate() {
    return [];
}

/**
 * Creates the sink.
 *
 * @param {{ config: { logFormat: string } }} ctx Provider context.
 * @returns {{ write: (record: object) => void }} The sink.
 */
export function create(ctx) {
    return consoleSink(console, ctx.config.logFormat);
}
