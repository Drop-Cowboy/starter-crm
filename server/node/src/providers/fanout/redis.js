/**
 * The `redis` fan-out: Redis pub/sub carries each finished event's id to every instance.
 *
 * Where it sits: `DC_FANOUT=redis`, the default whenever `DC_REDIS_URL` is set
 * and the store is shared. Publishing sends only the event id; each instance reads
 * the event from the store before it hands it to its streams, so contact data
 * never travels through pub/sub. One subscriber connection serves every stream on
 * the instance, not one per stream.
 *
 * Pub/sub does not remember messages: an instance that is disconnected misses
 * them, and its browsers catch up by replaying from the store when they reconnect.
 * Works with Redis 6.2+, Valkey, and Upstash.
 *
 * CONTRACT.md: "Fan-out".
 * Env: DC_REDIS_URL. What a customer changes: nothing.
 */

import { connectRedis, keyPrefix, validateRedis } from '../../redis.js';
import { publicEvent } from '../store/common.js';
import { createHub } from './hub.js';

export const name = 'redis';
export const configKeys = ['DC_REDIS_URL', 'REDIS_URL', 'DC_REDIS_CLUSTER'];

/**
 * Checks the Redis address.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    return validateRedis(env, 'DC_FANOUT=redis');
}

/**
 * Connects the publisher and the subscriber.
 *
 * @param {{ config: object, env: NodeJS.ProcessEnv, store: object }} ctx Provider context; `store` is where events are read.
 * @returns {Promise<object>} The fan-out instance.
 */
export async function create(ctx) {
    const channel = keyPrefix(ctx.config) + 'fanout';
    const publisher = await connectRedis(ctx.env);
    const subscriber = await connectRedis(ctx.env);
    const hub = createHub();

    // The message callback is the one place an event arrives from outside a request, so it cannot await
    // anything: it reads the event and delivers it, and an event the store no longer has is simply skipped.
    subscriber.on('message', (_channel, eventId) => {
        ctx.store.get(eventId).then((row) => {
            if (row) hub.deliver(publicEvent(row));
        }, () => {});
    });
    await subscriber.subscribe(channel);

    return {
        async publish(event) {
            await publisher.publish(channel, event.event_id);
        },
        subscribe: hub.subscribe,
        async ready() {
            try {
                return (await publisher.ping()) === 'PONG' && subscriber.status === 'ready';
            } catch {
                return false;
            }
        },
        async close() {
            await publisher.quit();
            await subscriber.quit();
        }
    };
}
