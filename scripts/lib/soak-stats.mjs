/**
 * The arithmetic and parsing behind `npm run soak`, kept apart from the process handling so it can be tested.
 *
 * Where it sits: scripts/soak.mjs feeds this file what it measured (acknowledgement times, memory samples,
 * the bytes of each event stream) and asks it for the verdict.
 *
 * Plan section 12, item 10: acknowledge under 1 s at p99, and no memory growth.
 */

/** What a run must achieve. `memoryGrowthMb` and `memoryGrowthRatio` must both be exceeded to count as growth. */
export const DEFAULT_LIMITS = Object.freeze({
    ackP99Ms: 1000,
    minDelivered: 0.999,
    memoryGrowthMb: 30,
    memoryGrowthRatio: 0.15
});

/**
 * The value at percentile `p` of a list, by the nearest-rank method.
 *
 * @param {number[]} values The measurements, in any order.
 * @param {number} p A percentile from 0 to 100.
 * @returns {number} The value, or 0 for an empty list.
 */
export function percentile(values, p) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
    return sorted[Math.min(rank, sorted.length) - 1];
}

/**
 * The middle value of a list.
 *
 * @param {number[]} values The measurements.
 * @returns {number} The median, or 0 for an empty list.
 */
export function median(values) {
    return percentile(values, 50);
}

/**
 * Whether memory grew over the run: the median of the last third of the samples against the median of the
 * first third, once the warm-up is over. A server that is merely busy settles; a leak keeps climbing.
 *
 * @param {{ at: number, rssMb: number }[]} samples Readings, `at` in milliseconds from the start.
 * @param {number} warmupMs Readings before this are ignored.
 * @param {{ memoryGrowthMb: number, memoryGrowthRatio: number }} limits The thresholds.
 * @returns {{ startMb: number, endMb: number, growthMb: number, grew: boolean, enough: boolean }} The comparison.
 */
export function memoryGrowth(samples, warmupMs, limits = DEFAULT_LIMITS) {
    const settled = samples.filter((sample) => sample.at >= warmupMs);
    if (settled.length < 6) return { startMb: 0, endMb: 0, growthMb: 0, grew: false, enough: false };
    const third = Math.floor(settled.length / 3);
    const startMb = median(settled.slice(0, third).map((sample) => sample.rssMb));
    const endMb = median(settled.slice(settled.length - third).map((sample) => sample.rssMb));
    const growthMb = endMb - startMb;
    const grew = growthMb > limits.memoryGrowthMb && growthMb > startMb * limits.memoryGrowthRatio;
    return { startMb, endMb, growthMb, grew, enough: true };
}

/**
 * An incremental Server-Sent Events parser. Feed it chunks as they arrive; it returns the messages
 * completed by each chunk and keeps the remainder for the next one.
 *
 * @returns {{ push: (chunk: string) => { id: string | null, event: string, data: string }[] }} The parser.
 */
export function createSseParser() {
    let pending = '';
    return {
        push(chunk) {
            pending += chunk;
            const messages = [];
            let end = pending.indexOf('\n\n');
            while (end !== -1) {
                const block = pending.slice(0, end);
                pending = pending.slice(end + 2);
                const message = { id: null, event: 'message', data: '' };
                let any = false;
                for (const line of block.split('\n')) {
                    if (line === '' || line.startsWith(':')) continue;
                    const colon = line.indexOf(':');
                    const field = colon === -1 ? line : line.slice(0, colon);
                    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
                    if (field === 'id') message.id = value;
                    else if (field === 'event') message.event = value;
                    else if (field === 'data') message.data += (message.data ? '\n' : '') + value;
                    else continue;
                    any = true;
                }
                if (any) messages.push(message);
                end = pending.indexOf('\n\n');
            }
            return messages;
        }
    };
}

/**
 * Judges a finished run.
 *
 * @param {object} run What was measured.
 * @param {number[]} run.ackMs Acknowledgement time of each successful webhook.
 * @param {number} run.posted Webhooks sent.
 * @param {number} run.failed Webhooks that did not answer 200.
 * @param {number} run.expectedDeliveries Messages the open streams should have received.
 * @param {number} run.delivered Messages they did receive.
 * @param {number} run.streamsLost Streams that closed before the end.
 * @param {{ grew: boolean, enough: boolean, startMb: number, endMb: number }} run.memory From `memoryGrowth()`.
 * @param {typeof DEFAULT_LIMITS} [limits] The thresholds.
 * @returns {{ ok: boolean, problems: string[], ackP50Ms: number, ackP99Ms: number, deliveredRatio: number }} The verdict.
 */
export function verdict(run, limits = DEFAULT_LIMITS) {
    const problems = [];
    const ackP50Ms = percentile(run.ackMs, 50);
    const ackP99Ms = percentile(run.ackMs, 99);
    const deliveredRatio = run.expectedDeliveries === 0 ? 1 : run.delivered / run.expectedDeliveries;
    if (run.posted === 0) problems.push('no webhooks were sent');
    if (run.failed > 0) problems.push(run.failed + ' of ' + run.posted + ' webhooks did not answer 200');
    if (ackP99Ms > limits.ackP99Ms) problems.push('p99 acknowledgement was ' + Math.round(ackP99Ms) + ' ms, over ' + limits.ackP99Ms + ' ms');
    if (deliveredRatio < limits.minDelivered) {
        problems.push('streams received ' + run.delivered + ' of ' + run.expectedDeliveries + ' messages (' + (deliveredRatio * 100).toFixed(2) + '%)');
    }
    if (run.streamsLost > 0) problems.push(run.streamsLost + ' streams closed before the end');
    if (run.memory.grew) {
        problems.push('memory grew from ' + run.memory.startMb.toFixed(0) + ' MB to ' + run.memory.endMb.toFixed(0) + ' MB');
    }
    return { ok: problems.length === 0, problems, ackP50Ms, ackP99Ms, deliveredRatio };
}
