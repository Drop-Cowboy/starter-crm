import { describe, expect, it } from 'vitest';
import { bootstrap } from '../src/bootstrap.js';
import { validate as validatePostgres } from '../src/providers/store/postgres.js';
import { validateRedis } from '../src/redis.js';
import { API_KEY, API_SECRET, SITE_ID, WEBHOOK_SECRET } from './helpers.js';

const PRODUCTION = { DC_ENV: 'production' };
const REMOTE_REDIS = { DC_REDIS_URL: 'redis://redis.example.net:6379' };
const REMOTE_POSTGRES = { DC_DATABASE_URL: 'postgres://u:p@db.example.net:5432/d' };

describe('plain connections to Redis and Postgres in production', () => {
    it('refuses a remote redis:// address', () => {
        expect(validateRedis({ ...PRODUCTION, ...REMOTE_REDIS }, 'DC_STORE=redis').map((p) => p.code)).toEqual(['insecure_redis_url']);
    });

    it('accepts rediss://, a local host, and development', () => {
        expect(validateRedis({ ...PRODUCTION, DC_REDIS_URL: 'rediss://cache.example.com:6379' }, 'x')).toEqual([]);
        expect(validateRedis({ ...PRODUCTION, DC_REDIS_URL: 'redis://localhost:6379' }, 'x')).toEqual([]);
        expect(validateRedis(REMOTE_REDIS, 'x')).toEqual([]);
    });

    it.each(['on', '1', 'true', 'ON'])('accepts a remote redis:// when DC_INSECURE_PRIVATE_SERVICES=%s', (value) => {
        expect(validateRedis({ ...PRODUCTION, ...REMOTE_REDIS, DC_INSECURE_PRIVATE_SERVICES: value }, 'x')).toEqual([]);
    });

    it('does not treat other values as consent', () => {
        expect(validateRedis({ ...PRODUCTION, ...REMOTE_REDIS, DC_INSECURE_PRIVATE_SERVICES: 'off' }, 'x')).toHaveLength(1);
    });

    it('refuses a remote Postgres without sslmode, and accepts it with sslmode or the opt-in', () => {
        expect(validatePostgres({ ...PRODUCTION, ...REMOTE_POSTGRES }).map((p) => p.code)).toEqual(['insecure_database_url']);
        expect(validatePostgres({ ...PRODUCTION, DC_DATABASE_URL: REMOTE_POSTGRES.DC_DATABASE_URL + '?sslmode=require' })).toEqual([]);
        expect(validatePostgres({ ...PRODUCTION, ...REMOTE_POSTGRES, DC_INSECURE_PRIVATE_SERVICES: 'on' })).toEqual([]);
    });
});

describe('boot problems', () => {
    it('reports a problem shared by several providers once', async () => {
        const booted = await bootstrap({
            DC_AUTH_MODE: 'server', DROPCOWBOY_API_KEY: API_KEY, DROPCOWBOY_API_SECRET: API_SECRET, DROPCOWBOY_SITE_ID: SITE_ID,
            DROPCOWBOY_WEBHOOK_SECRET: WEBHOOK_SECRET, DC_ENV: 'production', DC_IDENTITY: 'passcode', DC_PASSCODE: 'a-long-enough-passcode',
            DC_STORE: 'redis', DC_FANOUT: 'redis', DC_RATE_LIMIT: 'redis', DC_DATA: 'sqlite', ...REMOTE_REDIS
        }, '/x');
        expect(booted.problems.map((p) => p.code)).toEqual(['insecure_redis_url']);
    });
});
