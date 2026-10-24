/**
 * The `inline` webhook mode: handlers run before the webhook is acknowledged.
 *
 * Where it sits: `DC_WEBHOOKS=inline`. The simplest mode, for handlers that are
 * quick: the request waits for them, then answers 200. Drop Cowboy needs the answer
 * within 5 seconds, so a handler that can be slow belongs in a queue mode.
 *
 * The rules:
 * - Handlers get an `AbortSignal` that fires after `DC_WEBHOOK_HANDLER_BUDGET_MS`
 *   (default 3000). They should stop when it does, and a handler that overruns is
 *   logged as too slow for inline mode.
 * - Handlers are always awaited to completion. Nothing is left running after the
 *   response, which matters on hosts that freeze the process between requests.
 * - A handler that fails leaves the event `received`, and the webhook answers 503 so
 *   Drop Cowboy retries; the retry runs the handlers again. After
 *   `DC_WEBHOOK_MAX_ATTEMPTS` the event is `failed` and acknowledged.
 *
 * CONTRACT.md: "POST /webhooks/dropcowboy" (Processing).
 * Env: DC_WEBHOOK_HANDLER_BUDGET_MS. What a customer changes: nothing.
 */

export const name = 'inline';
export const configKeys = ['DC_WEBHOOK_HANDLER_BUDGET_MS'];

/**
 * Nothing beyond the budget, which the config parser checks.
 *
 * @returns {object[]} No problems.
 */
export function validate() {
    return [];
}

/**
 * Creates the dispatcher.
 *
 * @param {{ config: object, processor: object }} ctx Provider context.
 * @returns {object} The dispatcher (see store.js for the interface).
 */
export function create(ctx) {
    return {
        /** How long a recorded event waits before the maintenance sweep may touch it, so the sweep never races a live request. */
        visibleDelayMs: 120000,
        async dispatch(eventId) {
            const result = await ctx.processor.process(eventId, { budgetMs: ctx.config.events.handlerBudgetMs });
            return { outcome: result.outcome, error: result.error };
        },
        async sweep(eventIds) {
            for (const id of eventIds) await ctx.processor.process(id, { budgetMs: ctx.config.events.handlerBudgetMs });
        },
        async start() {},
        async stop() {},
        async ready() {
            return true;
        }
    };
}
