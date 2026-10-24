import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import * as memoryData from '../src/providers/data/memory.js';
import { collectRoutes, createModules, loadModules, matchPath, shapeProblem } from '../src/modules.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-crm-modules-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const noop = () => ({});

describe('shapeProblem', () => {
    it('accepts a module whose id matches its folder', () => {
        expect(shapeProblem({ id: 'tickets', routes: noop, onEvent: { '*': noop } }, 'tickets')).toBeNull();
    });

    it.each([
        [undefined, 'tickets', /export default an object/],
        [{ id: 'Tickets' }, 'Tickets', /id/],
        [{ id: 'tickets' }, 'other', /match its folder/],
        [{ id: 'tickets', routes: 'x' }, 'tickets', /routes/],
        [{ id: 'tickets', onEvent: { 'contact.deleted': 1 } }, 'tickets', /not a function/]
    ])('names what is wrong with %j', (mod, folder, message) => {
        expect(shapeProblem(mod, folder)).toMatch(message);
    });
});

describe('collectRoutes', () => {
    const collect = (routes) => collectRoutes({ id: 'tickets', routes });

    it('gives each route its full path', () => {
        const found = collect((router) => {
            router.get('/', noop);
            router.post('/:id', { body: { type: 'object' } }, noop);
            router.delete('/:id', noop);
        });
        expect(found.map((r) => r.method + ' ' + r.path)).toEqual(['GET /api/modules/tickets', 'POST /api/modules/tickets/:id', 'DELETE /api/modules/tickets/:id']);
        expect(found[1].body).toEqual({ type: 'object' });
    });

    it('refuses a bad path, a repeated route, a missing handler, a GET body and an unsupported keyword', () => {
        expect(() => collect((router) => router.get('items', noop))).toThrow(/path/);
        expect(() => collect((router) => router.get('/../x', noop))).toThrow(/path/);
        expect(() => collect((router) => { router.get('/', noop); router.get('/', noop); })).toThrow(/twice/);
        expect(() => collect((router) => router.get('/', 'nope'))).toThrow(/handler/);
        expect(() => collect((router) => router.get('/', { body: { type: 'object' } }, noop))).toThrow(/GET/);
        expect(() => collect((router) => router.post('/', { body: { oneOf: [] } }, noop))).toThrow(/oneOf/);
    });
});

describe('matchPath', () => {
    const pattern = '/api/modules/deals/:id'.split('/');

    it('returns the parameters of a matching path', () => {
        expect(matchPath(pattern, '/api/modules/deals/abc')).toEqual({ id: 'abc' });
        expect(matchPath(pattern, '/api/modules/deals/a%20b')).toEqual({ id: 'a b' });
    });

    it('does not match another path, an empty parameter or bad percent-encoding', () => {
        expect(matchPath(pattern, '/api/modules/deals')).toBeNull();
        expect(matchPath(pattern, '/api/modules/deals/')).toBeNull();
        expect(matchPath(pattern, '/api/modules/deals/a/b')).toBeNull();
        expect(matchPath(pattern, '/api/modules/other/abc')).toBeNull();
        expect(matchPath(pattern, '/api/modules/deals/%E0%A4%A')).toBeNull();
    });
});

describe('loadModules', () => {
    it('loads a folder module and reports a broken one', async () => {
        const good = path.join(tmp, 'good');
        fs.mkdirSync(path.join(good, 'tickets'), { recursive: true });
        fs.writeFileSync(path.join(good, 'tickets', 'index.js'), "export default { id: 'tickets', routes(router) { router.get('/', () => ({})); } };\n");
        const loaded = await loadModules(good);
        expect(loaded.problem).toBeNull();
        expect(loaded.modules.map((m) => m.id)).toEqual(['tickets']);

        const bad = path.join(tmp, 'bad');
        fs.mkdirSync(path.join(bad, 'tickets'), { recursive: true });
        fs.writeFileSync(path.join(bad, 'tickets', 'index.js'), "export default { id: 'wrong' };\n");
        expect((await loadModules(bad)).problem).toMatch(/match its folder/);

        const broken = path.join(tmp, 'broken');
        fs.mkdirSync(path.join(broken, 'tickets'), { recursive: true });
        fs.writeFileSync(path.join(broken, 'tickets', 'index.js'), 'export default {;\n');
        expect((await loadModules(broken)).problem).toMatch(/could not be loaded/);
    });

    it('treats a missing folder as no modules', async () => {
        expect(await loadModules(path.join(tmp, 'nope'))).toEqual({ modules: [], problem: null });
    });

    it('loads the built-in Deals module', async () => {
        const loaded = await loadModules();
        expect(loaded.problem).toBeNull();
        expect(loaded.modules.map((m) => m.id)).toContain('deals');
    });
});

describe('event hooks', () => {
    it('hands an event to the modules that name it, and to "*", with the system view of the data', async () => {
        const data = memoryData.create({ config: {} });
        const seen = [];
        const modules = [
            { id: 'one', onEvent: { 'contact.deleted': async (event, ctx) => { seen.push(['one', event.event, ctx.eventId, ctx.attempt, typeof ctx.data.collection]); } } },
            { id: 'two', onEvent: { '*': async (event) => { seen.push(['two', event.event]); } } },
            { id: 'three', onEvent: { 'contact.created': async () => { seen.push(['three']); } } }
        ];
        const runtime = createModules(modules, { data, config: {}, log: {} });
        await runtime.runEventHooks({ event: 'contact.deleted' }, { log: {}, signal: undefined, eventId: 'e1', attempt: 2 });
        expect(seen).toEqual([['one', 'contact.deleted', 'e1', 2, 'function'], ['two', 'contact.deleted']]);
    });

    it('lets a failing handler fail the whole run, so the event is retried', async () => {
        const data = memoryData.create({ config: {} });
        const runtime = createModules([{ id: 'one', onEvent: { '*': async () => { throw new Error('boom'); } } }], { data, config: {}, log: {} });
        await expect(runtime.runEventHooks({ event: 'x' }, { log: {}, eventId: 'e', attempt: 1 })).rejects.toThrow('boom');
    });
});
