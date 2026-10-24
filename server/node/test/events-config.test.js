import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const FIXTURE = JSON.parse(readFileSync(new URL('../../conformance/provider/events-config.json', import.meta.url), 'utf8'));

function summarize(events) {
    if (!events) {
        return null;
    }
    return {
        store: events.store, fanout: events.fanout, webhooks: events.webhooks, retention: events.retentionHours,
        stream: events.maxStreamSeconds, keepalive: events.keepaliveSeconds, fpoll: events.fanoutPollMs, opoll: events.outboxPollMs,
        attempts: events.maxAttempts, budget: events.handlerBudgetMs, handlers: events.handlersPath,
        worker: events.workerInProcess, sqlite: events.sqlitePath
    };
}

describe('event settings (shared with the Python server)', () => {
    it.each(FIXTURE.cases.map((c) => [JSON.stringify(c.env), c]))('resolves %s', (_label, entry) => {
        const { config, problems } = loadConfig({ ...FIXTURE.base, ...entry.env }, '/nonexistent');
        expect(problems.map((p) => p.code).sort()).toEqual(entry.codes);
        expect(summarize(config?.events)).toEqual(entry.events);
        expect(config?.data.provider).toEqual(entry.data);
    });
});
