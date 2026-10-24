/**
 * The `dynamodb` event store: events in one DynamoDB table every instance shares.
 *
 * Where it sits: `DC_STORE=dynamodb`, the store for AWS (the ECS Express template creates the table). It suits
 * hosts with no SQL database, and any number of servers and workers can record, claim and replay against the same
 * table. The AWS SDK finds its credentials itself (the ECS task role); `AWS_REGION` says where the table is, and
 * `AWS_ENDPOINT_URL` points at a local stand-in such as dynamodb-local.
 *
 * How events are laid out (one site's events share one partition; a starter is not a firehose):
 * - the event itself: `pk = E#<site>`, `sk = <event_id>`, with the public event as a JSON string, its status, attempt
 *   count, retry time and error;
 * - the index `gsi1` orders them by state: partition `R#<site>` holds events waiting for a handler, sorted by when
 *   they are next due; `D#<site>` holds processed events and `X#<site>` failed ones, both sorted by when they finished
 *   (that order is replay);
 * - the index `gsi2` groups a contact's events (`C#<site>#<contact_id>`), so `contact.deleted` can erase them.
 * An event is in exactly one state partition, so moving it is one update.
 *
 * Index reads are eventually consistent (usually within a few milliseconds). That is fine here: the outbox polls,
 * replay overlaps by 5 seconds, and `pending()` claims each event with a conditional write, so a stale read can only
 * make a worker skip an event until its next poll, never run it twice. Finished events carry `expires_at`, so DynamoDB's
 * own time-to-live removes stragglers, and `prune()` removes them on time.
 *
 * An item is at most 400 KB, so an event whose JSON is larger cannot be recorded (the webhook answers
 * `503 webhook_not_queued` and Drop Cowboy retries). Drop Cowboy's events are far smaller.
 *
 * CONTRACT.md: "Event store".
 * Env: AWS_REGION, AWS_ENDPOINT_URL, DC_DYNAMODB_TABLE, DC_DYNAMODB_AUTO_CREATE. What a customer changes: nothing.
 */

import { autoCreate, connectDynamo, dynamoTable, ensureTable, pad, validateAws, validateTable } from '../../aws.js';
import { DEFAULT_LEASE_MS, REPLAY_OVERLAP_MS, STATUSES, contactIdOf, publicEvent, replayLimit, retentionMs, siteKey } from './common.js';

export const name = 'dynamodb';
export const configKeys = ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_DYNAMODB', 'DC_DYNAMODB_TABLE', 'DC_DYNAMODB_AUTO_CREATE'];

/** The most keys a batch write takes. */
const BATCH = 25;

/**
 * Checks the region, the endpoint and the table name.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    return [...validateAws(env, 'DC_STORE=dynamodb', 'DYNAMODB'), ...validateTable(env)];
}

/**
 * Turns a stored item into the event object every store returns.
 *
 * @param {Record<string, any>|undefined} item The DynamoDB item.
 * @returns {object|null} The event with `status`, `attempts`, `next_attempt_at`, `last_error`, `done_at`; null when there is no item.
 */
function fromItem(item) {
    if (!item || typeof item.json !== 'string') return null;
    const base = JSON.parse(item.json);
    return {
        event_id: base.event_id,
        event: base.event,
        event_at: base.event_at,
        received_at: base.received_at,
        attempt: base.attempt,
        data: base.data,
        contact_id: item.contact_id ?? null,
        status: item.status,
        attempts: Number(item.attempts),
        next_attempt_at: Number(item.next_attempt_at),
        last_error: item.last_error ?? null,
        done_at: item.done_at === undefined ? null : Number(item.done_at)
    };
}

/**
 * Creates the store.
 *
 * @param {{ config: object, env: NodeJS.ProcessEnv, now?: () => number, client?: object }} ctx Provider context; `now`
 *   and `client` (what `connectDynamo()` returns) are replaced in tests.
 * @returns {Promise<object>} The store (see the interface in memory.js).
 */
export async function create(ctx) {
    const now = ctx.now || Date.now;
    const keepMs = retentionMs(ctx.config);
    const site = siteKey(ctx.config);
    const table = dynamoTable(ctx.env);
    const client = ctx.client || await connectDynamo(ctx.env);
    const { doc, sdk } = client;
    await ensureTable(client, table, autoCreate(ctx.env));

    const pk = 'E#' + site;
    const partition = { received: 'R#' + site, processed: 'D#' + site, failed: 'X#' + site };

    /**
     * Whether an error means "the condition did not hold".
     *
     * @param {unknown} err What the SDK threw.
     * @returns {boolean} True for `ConditionalCheckFailedException`.
     */
    function conditionFailed(err) {
        return Boolean(err) && err.name === 'ConditionalCheckFailedException';
    }

    /**
     * Reads every item an index query returns, following its pages.
     *
     * @param {object} input The `Query` input (`Limit` caps the number of items, not of pages).
     * @returns {Promise<object[]>} The items.
     */
    async function queryAll(input) {
        const items = [];
        let startKey;
        do {
            const remaining = input.Limit === undefined ? undefined : input.Limit - items.length;
            const page = await doc.send(new sdk.QueryCommand({ TableName: table, ...input, Limit: remaining, ExclusiveStartKey: startKey }));
            for (const item of page.Items || []) items.push(item);
            startKey = page.LastEvaluatedKey;
            if (input.Limit !== undefined && items.length >= input.Limit) break;
        } while (startKey);
        return items;
    }

    /**
     * Counts the items in an index partition.
     *
     * @param {string} indexPk The `gsi1pk` value.
     * @returns {Promise<number>} How many items it holds.
     */
    async function countPartition(indexPk) {
        let total = 0;
        let startKey;
        do {
            const page = await doc.send(new sdk.QueryCommand({
                TableName: table, IndexName: 'gsi1', Select: 'COUNT',
                KeyConditionExpression: 'gsi1pk = :p', ExpressionAttributeValues: { ':p': indexPk }, ExclusiveStartKey: startKey
            }));
            total += page.Count || 0;
            startKey = page.LastEvaluatedKey;
        } while (startKey);
        return total;
    }

    /**
     * Deletes items by key, 25 at a time, retrying what DynamoDB sends back.
     *
     * @param {{ pk: string, sk: string }[]} keys The items to delete.
     * @returns {Promise<void>}
     */
    async function deleteKeys(keys) {
        for (let i = 0; i < keys.length; i += BATCH) {
            let requests = keys.slice(i, i + BATCH).map((key) => ({ DeleteRequest: { Key: { pk: key.pk, sk: key.sk } } }));
            for (let attempt = 0; requests.length > 0; attempt++) {
                const result = await doc.send(new sdk.BatchWriteCommand({ RequestItems: { [table]: requests } }));
                requests = (result.UnprocessedItems && result.UnprocessedItems[table]) || [];
                if (requests.length > 0 && attempt >= 5) throw new Error('DynamoDB would not delete ' + requests.length + ' item(s) after 6 tries.');
                if (requests.length > 0) await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
            }
        }
    }

    /**
     * Moves an event to a finished state.
     *
     * @param {string} eventId The event.
     * @param {string} status `processed` or `failed`.
     * @param {string|null} error The error text, for `failed`.
     * @returns {Promise<void>}
     */
    async function finish(eventId, status, error) {
        const at = now();
        const names = { '#s': 'status', '#d': 'done_at', '#p': 'gsi1pk', '#k': 'gsi1sk', '#x': 'expires_at' };
        const values = {
            ':s': status, ':d': at, ':p': status === STATUSES.failed ? partition.failed : partition.processed,
            ':k': pad(at) + '#' + eventId, ':x': Math.floor((at + keepMs) / 1000)
        };
        let expression = 'SET #s = :s, #d = :d, #p = :p, #k = :k, #x = :x';
        if (error !== null) {
            names['#e'] = 'last_error';
            values[':e'] = error || 'failed';
            expression += ', #e = :e';
        }
        try {
            await doc.send(new sdk.UpdateCommand({
                TableName: table, Key: { pk, sk: eventId }, UpdateExpression: expression,
                ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeNames: names, ExpressionAttributeValues: values
            }));
        } catch (err) {
            if (!conditionFailed(err)) throw err;
        }
    }

    /**
     * Reads one event.
     *
     * @param {string} eventId The event.
     * @returns {Promise<object|null>} The event, or null when it does not exist or has expired.
     */
    async function getEvent(eventId) {
        const result = await doc.send(new sdk.GetCommand({ TableName: table, Key: { pk, sk: eventId }, ConsistentRead: true }));
        const item = result.Item;
        // DynamoDB's time-to-live removes items lazily, so an expired one can still be there for a while.
        if (item && item.expires_at !== undefined && Number(item.expires_at) * 1000 <= now()) return null;
        return fromItem(item);
    }

    return {
        async record(event, { visibleAt } = {}) {
            const due = visibleAt ?? now();
            const contactId = contactIdOf(event.data);
            const item = {
                pk, sk: event.event_id, json: JSON.stringify(publicEvent(event)), status: STATUSES.received,
                attempts: 0, next_attempt_at: due, received_at: event.received_at,
                gsi1pk: partition.received, gsi1sk: pad(due) + '#' + event.event_id
            };
            if (contactId) {
                item.contact_id = contactId;
                item.gsi2pk = 'C#' + site + '#' + contactId;
                item.gsi2sk = event.event_id;
            }
            try {
                await doc.send(new sdk.PutCommand({ TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' }));
                return { inserted: true, status: STATUSES.received };
            } catch (err) {
                if (!conditionFailed(err)) throw err;
                const existing = await getEvent(event.event_id);
                return { inserted: false, status: existing ? existing.status : STATUSES.received };
            }
        },

        get(eventId) {
            return getEvent(eventId);
        },

        markProcessed(eventId) {
            return finish(eventId, STATUSES.processed, null);
        },

        markFailed(eventId, error) {
            return finish(eventId, STATUSES.failed, String(error));
        },

        async noteFailure(eventId, error, nextAttemptAt) {
            const key = { pk, sk: eventId };
            const common = { TableName: table, Key: key, ReturnValues: 'UPDATED_NEW' };
            try {
                // An event still waiting moves to its new due time in the outbox index too.
                const result = await doc.send(new sdk.UpdateCommand({
                    ...common,
                    UpdateExpression: 'ADD attempts :one SET last_error = :e, next_attempt_at = :n, gsi1sk = :k',
                    ConditionExpression: '#s = :received',
                    ExpressionAttributeNames: { '#s': 'status' },
                    ExpressionAttributeValues: { ':one': 1, ':e': String(error), ':n': nextAttemptAt, ':k': pad(nextAttemptAt) + '#' + eventId, ':received': STATUSES.received }
                }));
                return Number(result.Attributes.attempts);
            } catch (err) {
                if (!conditionFailed(err)) throw err;
            }
            try {
                const result = await doc.send(new sdk.UpdateCommand({
                    ...common,
                    UpdateExpression: 'ADD attempts :one SET last_error = :e, next_attempt_at = :n',
                    ConditionExpression: 'attribute_exists(pk)',
                    ExpressionAttributeValues: { ':one': 1, ':e': String(error), ':n': nextAttemptAt }
                }));
                return Number(result.Attributes.attempts);
            } catch (err) {
                if (conditionFailed(err)) return 0;
                throw err;
            }
        },

        async since({ afterEventId, limit } = {}) {
            const size = replayLimit(limit);
            // An index key cannot be an empty string; "0" sorts before every 13-digit time.
            let from = '0';
            if (afterEventId) {
                const cursor = await getEvent(afterEventId);
                if (cursor && cursor.done_at !== null) from = pad(cursor.done_at - REPLAY_OVERLAP_MS);
            }
            // Processed and failed events sit in two partitions; the newest `size + 1` of each is enough to find the newest `size` of both.
            const newest = async (indexPk) => queryAll({
                IndexName: 'gsi1', ScanIndexForward: false, Limit: size + 1,
                KeyConditionExpression: 'gsi1pk = :p AND gsi1sk >= :f', ExpressionAttributeValues: { ':p': indexPk, ':f': from }
            });
            const [processed, failed] = await Promise.all([newest(partition.processed), newest(partition.failed)]);
            const window = [...processed, ...failed]
                .map(fromItem)
                .filter((event) => event && event.event_id !== afterEventId)
                .sort((a, b) => a.done_at - b.done_at || (a.event_id < b.event_id ? -1 : 1));
            return window.slice(-size).map(publicEvent);
        },

        async pending({ limit = 10, leaseMs = DEFAULT_LEASE_MS } = {}) {
            const at = now();
            const due = await queryAll({
                IndexName: 'gsi1', Limit: limit,
                KeyConditionExpression: 'gsi1pk = :p AND gsi1sk <= :t',
                ExpressionAttributeValues: { ':p': partition.received, ':t': pad(at) + '#~' }
            });
            const claimed = [];
            for (const item of due) {
                const until = at + leaseMs;
                try {
                    // The index read may be a moment stale, so the claim only succeeds if the event is still due as the read saw it.
                    const result = await doc.send(new sdk.UpdateCommand({
                        TableName: table, Key: { pk, sk: item.sk }, ReturnValues: 'ALL_NEW',
                        UpdateExpression: 'SET next_attempt_at = :u, gsi1sk = :k',
                        ConditionExpression: '#s = :received AND next_attempt_at = :old',
                        ExpressionAttributeNames: { '#s': 'status' },
                        ExpressionAttributeValues: { ':u': until, ':k': pad(until) + '#' + item.sk, ':received': STATUSES.received, ':old': item.next_attempt_at }
                    }));
                    claimed.push(fromItem(result.Attributes));
                } catch (err) {
                    if (!conditionFailed(err)) throw err;
                }
            }
            return claimed;
        },

        async listFailed({ limit = 50 } = {}) {
            const items = await queryAll({
                IndexName: 'gsi1', ScanIndexForward: false, Limit: limit,
                KeyConditionExpression: 'gsi1pk = :p', ExpressionAttributeValues: { ':p': partition.failed }
            });
            return items.map(fromItem).filter(Boolean);
        },

        async replay(eventId) {
            const at = now();
            try {
                await doc.send(new sdk.UpdateCommand({
                    TableName: table, Key: { pk, sk: eventId },
                    UpdateExpression: 'SET #s = :received, attempts = :zero, next_attempt_at = :n, gsi1pk = :p, gsi1sk = :k REMOVE done_at, expires_at',
                    ConditionExpression: '#s = :failed',
                    ExpressionAttributeNames: { '#s': 'status' },
                    ExpressionAttributeValues: { ':received': STATUSES.received, ':failed': STATUSES.failed, ':zero': 0, ':n': at, ':p': partition.received, ':k': pad(at) + '#' + eventId }
                }));
                return true;
            } catch (err) {
                if (conditionFailed(err)) return false;
                throw err;
            }
        },

        async purgeContact(contactId, keepEventId) {
            const items = await queryAll({
                IndexName: 'gsi2', KeyConditionExpression: 'gsi2pk = :p', ExpressionAttributeValues: { ':p': 'C#' + site + '#' + contactId }
            });
            const doomed = items.filter((item) => item.sk !== keepEventId);
            await deleteKeys(doomed.map((item) => ({ pk: item.pk, sk: item.sk })));
            const kept = items.find((item) => item.sk === keepEventId);
            if (kept) {
                const base = JSON.parse(kept.json);
                base.data = { contact_id: contactId };
                await doc.send(new sdk.UpdateCommand({
                    TableName: table, Key: { pk, sk: keepEventId }, UpdateExpression: 'SET json = :j', ExpressionAttributeValues: { ':j': JSON.stringify(base) }
                }));
            }
            return doomed.length;
        },

        async counts() {
            const [received, processed, failed] = await Promise.all([
                countPartition(partition.received), countPartition(partition.processed), countPartition(partition.failed)
            ]);
            const out = { received, processed, failed, oldest_received_age_seconds: 0 };
            const oldest = await queryAll({
                IndexName: 'gsi1', Limit: 20, KeyConditionExpression: 'gsi1pk = :p', ExpressionAttributeValues: { ':p': partition.received }
            });
            let earliest = null;
            for (const item of oldest) {
                const received_at = Number(item.received_at);
                if (earliest === null || received_at < earliest) earliest = received_at;
            }
            if (earliest !== null) out.oldest_received_age_seconds = Math.max(0, Math.round((now() - earliest) / 1000));
            return out;
        },

        async prune() {
            const cutoff = pad(now() - keepMs);
            let removed = 0;
            for (const indexPk of [partition.processed, partition.failed]) {
                const old = await queryAll({
                    IndexName: 'gsi1', KeyConditionExpression: 'gsi1pk = :p AND gsi1sk < :c', ExpressionAttributeValues: { ':p': indexPk, ':c': cutoff }
                });
                await deleteKeys(old.map((item) => ({ pk: item.pk, sk: item.sk })));
                removed += old.length;
            }
            return removed;
        },

        async ready() {
            try {
                const result = await client.raw.send(new sdk.DescribeTableCommand({ TableName: table }));
                return result.Table.TableStatus === 'ACTIVE' || result.Table.TableStatus === 'UPDATING';
            } catch {
                return false;
            }
        },

        async close() {
            if (!ctx.client) client.raw.destroy();
        }
    };
}
