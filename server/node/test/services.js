// Where the real Postgres and Valkey from tests/services.compose.yml listen, and
// whether anything is there. The suites that need them skip, with a notice,
// when nothing answers, so a developer without Docker still gets a green run.
import crypto from 'node:crypto';
import net from 'node:net';

export const POSTGRES_URL = process.env.STARTER_TEST_DATABASE_URL || 'postgres://starter:starter-crm-dev@127.0.0.1:55432/starter_crm';
export const REDIS_URL = process.env.STARTER_TEST_REDIS_URL || 'redis://127.0.0.1:56379';
export const REDIS_CLUSTER_URL = process.env.STARTER_TEST_REDIS_CLUSTER_URL || 'redis://127.0.0.1:55380';
export const DYNAMODB_URL = process.env.STARTER_TEST_DYNAMODB_URL || 'http://127.0.0.1:58000';
export const SQS_URL = process.env.STARTER_TEST_SQS_URL || 'http://127.0.0.1:59324';
export const QSTASH_URL = process.env.STARTER_TEST_QSTASH_URL || 'http://127.0.0.1:58080';

/** The credentials the QStash development server prints at startup; they are the same on every machine and open nothing real. */
export const QSTASH_DEV = Object.freeze({
    QSTASH_URL,
    QSTASH_TOKEN: 'eyJVc2VySUQiOiJkZWZhdWx0VXNlciIsIlBhc3N3b3JkIjoiZGVmYXVsdFBhc3N3b3JkIn0=',
    QSTASH_CURRENT_SIGNING_KEY: 'sig_' + '7kYjw48mhY7kAjqNGcy6cr29RJ6r',
    QSTASH_NEXT_SIGNING_KEY: 'sig_' + '5ZB6DVzB1wjE8S6rZ7eenA8Pdnhs'
});

/**
 * The settings that point the AWS SDK at the local stand-ins (dynamodb-local, ElasticMQ). The credentials are dummies:
 * the stand-ins accept any.
 *
 * @param {Record<string, string>} [extra] More settings to merge in.
 * @returns {Record<string, string>} An environment for a provider's `ctx.env`.
 */
export function awsTestEnv(extra = {}) {
    return Object.assign({
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
        AWS_ENDPOINT_URL_DYNAMODB: DYNAMODB_URL,
        AWS_ENDPOINT_URL_SQS: SQS_URL,
        DC_DYNAMODB_AUTO_CREATE: 'on'
    }, extra);
}

/**
 * Tries a TCP connection.
 *
 * @param {string} url A service URL.
 * @returns {Promise<boolean>} True when something accepts connections there.
 */
function reachable(url) {
    const { hostname, port } = new URL(url);
    return new Promise((resolve) => {
        const socket = net.connect({ host: hostname, port: Number(port) });
        socket.setTimeout(1000);
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('timeout', () => { socket.destroy(); resolve(false); });
        socket.once('error', () => resolve(false));
    });
}

export const HAVE_POSTGRES = await reachable(POSTGRES_URL);
export const HAVE_REDIS = await reachable(REDIS_URL);
export const HAVE_REDIS_CLUSTER = await reachable(REDIS_CLUSTER_URL);
export const HAVE_DYNAMODB = await reachable(DYNAMODB_URL);
export const HAVE_SQS = await reachable(SQS_URL);
export const HAVE_QSTASH = await reachable(QSTASH_URL);

/** @returns {string} A fresh site id, so suites sharing one database never see each other's events. */
export function freshSite() {
    return crypto.randomUUID();
}
