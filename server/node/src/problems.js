/**
 * Structured boot problems for the Starter CRM server.
 *
 * Where it sits: loadConfig() builds these; index.js prints them and exits
 * before createApp() runs. Conformance suite 08-boot matches on `code` and
 * on variable names in `message`.
 *
 * CONTRACT.md: "Configuration" → "Boot" (structured problems).
 * Customers read the same codes in TROUBLESHOOTING.md.
 */

/**
 * One thing wrong with the configuration, in a shape tests and operators can read.
 *
 * @typedef {object} BootProblem
 * @property {string} code Stable machine id (see CONTRACT.md / TROUBLESHOOTING.md).
 * @property {string} message Plain-language description; names env vars, never secrets.
 * @property {string} fix What to change to clear the problem.
 * @property {string} docs Relative docs pointer, usually TROUBLESHOOTING.md#code.
 */

/**
 * Builds one boot problem.
 *
 * @param {string} code Stable machine id, also the TROUBLESHOOTING.md anchor.
 * @param {string} message Plain-language description; names env vars, never secrets.
 * @param {string} fix What the operator should change.
 * @returns {BootProblem} The structured problem, with its docs pointer filled in.
 */
export function problem(code, message, fix) {
    return {
        code,
        message,
        fix,
        docs: 'TROUBLESHOOTING.md#' + code
    };
}

/**
 * Formats problems for stderr. Keep variable names in `message` so older
 * substring checks in 08-boot still pass.
 *
 * @param {BootProblem[]} problems The problems loadConfig() collected.
 * @returns {string} Multi-line text ready for stderr.
 */
export function formatProblems(problems) {
    const lines = [];
    for (const item of problems) {
        lines.push(item.code + ': ' + item.message);
        lines.push('    fix: ' + item.fix);
        lines.push('    docs: ' + item.docs);
    }
    return lines.join('\n');
}

/**
 * True when `value` looks like a structured problem (not a legacy string).
 *
 * @param {unknown} value Anything; legacy code produced plain strings.
 * @returns {value is BootProblem} Whether `value` has a string `code`.
 */
export function isProblem(value) {
    return Boolean(value && typeof value === 'object' && typeof value.code === 'string');
}
