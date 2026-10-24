/**
 * The `dynamodb` data provider: module documents in the same DynamoDB table as the event store.
 *
 * Where it sits: `DC_DATA=dynamodb`, which is also what `DC_STORE=dynamodb` selects. It shares the table, the
 * credentials and the region with `store/dynamodb.js`, so an AWS deployment needs one table and one IAM policy.
 * It implements the data interface in memory.js; see CONTRACT.md, "Module data".
 *
 * How documents are laid out:
 * - the document: `pk = M#<site>#<owner>#<collection>`, `sk = <id>`, its fields in a native map `f` (so a number
 *   stays a number and a filter on `true` never matches `"true"`), plus `owner_id`, `created_at` and `updated_at`;
 * - a pointer, `pk = MI#<site>#<collection>#<id>`, `sk = i`, holding the owner, written in the same transaction, so
 *   the system view (which has no owner) finds a document by id with two strongly consistent reads;
 * - the index `gsi1` (`gsi1pk = M#<site>#<collection>`, `gsi1sk = <created_at>#<id>`) lists a collection across
 *   owners, newest first, for the system view.
 * Site and owner ids are URL-encoded where they sit in a key, so a `#` in one can never be read as a separator.
 *
 * Limits, which suit a starter and are worth knowing:
 * - A scoped `list()` reads the owner's whole collection (a strongly consistent query), filters it here and sorts it
 *   newest first, so it is meant for up to a few thousand documents per owner and collection. For more, add an
 *   index on your filter field to the table and query it from your own provider.
 * - The system view's `list()` goes through `gsi1`, which is eventually consistent (milliseconds): a document written
 *   an instant ago may not be listed yet. Each listed document is re-read consistently, so its fields are never stale.
 * - An item is at most 400 KB.
 *
 * CONTRACT.md: "Module data".
 * Env: AWS_REGION, AWS_ENDPOINT_URL, DC_DYNAMODB_TABLE, DC_DYNAMODB_AUTO_CREATE. What a customer changes: nothing.
 */

import { autoCreate, connectDynamo, dynamoTable, ensureTable, pad, validateAws, validateTable } from '../../aws.js';
import { siteKey } from '../store/common.js';
import { buildViews, newId, toDocument } from './common.js';

export const name = 'dynamodb';
export const configKeys = ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_DYNAMODB', 'DC_DYNAMODB_TABLE', 'DC_DYNAMODB_AUTO_CREATE'];

/** The most keys one BatchGet takes. */
const BATCH_GET = 100;

/**
 * Checks the region, the endpoint and the table name.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    return [...validateAws(env, 'DC_DATA=dynamodb', 'DYNAMODB'), ...validateTable(env)];
}

/**
 * Whether a stored field equals a filter value, with no JavaScript coercion.
 *
 * @param {unknown} stored What the document holds.
 * @param {string|number|boolean} wanted What the filter asks for.
 * @returns {boolean} True when they are the same type and value.
 */
function same(stored, wanted) {
    return typeof stored === typeof wanted && stored === wanted;
}

/**
 * Turns a stored item into the row shape `toDocument` takes.
 *
 * @param {Record<string, any>} item The DynamoDB item.
 * @returns {object} The document.
 */
function fromItem(item) {
    return toDocument({
        id: item.sk, owner_id: item.owner_id, created_at: Number(item.created_at), updated_at: Number(item.updated_at)
    }, item.f);
}

/**
 * Whether an error is a transaction that was cancelled because a condition did not hold.
 *
 * @param {unknown} err What the SDK threw.
 * @returns {boolean} True for `TransactionCanceledException` or `ConditionalCheckFailedException`.
 */
function conditionFailed(err) {
    return Boolean(err) && (err.name === 'TransactionCanceledException' || err.name === 'ConditionalCheckFailedException');
}

/**
 * Creates the provider.
 *
 * @param {{ config: object, env: NodeJS.ProcessEnv, now?: () => number, client?: object }} ctx Provider context; `now`
 *   and `client` (what `connectDynamo()` returns) are replaced in tests.
 * @returns {Promise<object>} The provider (see the interface in memory.js).
 */
export async function create(ctx) {
    const now = ctx.now || Date.now;
    const site = encodeURIComponent(siteKey(ctx.config));
    const table = dynamoTable(ctx.env);
    const client = ctx.client || await connectDynamo(ctx.env);
    const { doc, sdk } = client;
    await ensureTable(client, table, autoCreate(ctx.env));

    const partitionOf = (collection, owner) => 'M#' + site + '#' + encodeURIComponent(owner) + '#' + collection;
    const pointerOf = (collection, id) => 'MI#' + site + '#' + collection + '#' + encodeURIComponent(id);
    const indexOf = (collection) => 'M#' + site + '#' + collection;

    /**
     * Finds the owner of a document, for the system view.
     *
     * @param {string} collection The collection.
     * @param {string} id The document id.
     * @returns {Promise<string|null>} The owner, or null when there is no such document.
     */
    async function ownerOf(collection, id) {
        const result = await doc.send(new sdk.GetCommand({ TableName: table, Key: { pk: pointerOf(collection, id), sk: 'i' }, ConsistentRead: true }));
        return result.Item ? result.Item.owner_id : null;
    }

    /**
     * Reads one document.
     *
     * @param {string} collection The collection.
     * @param {string|null} owner The owner to limit to, or null for any.
     * @param {string} id The document id.
     * @returns {Promise<object|null>} The item, or null when it is missing or another owner's.
     */
    async function readItem(collection, owner, id) {
        const actual = owner === null ? await ownerOf(collection, id) : owner;
        if (actual === null) return null;
        const result = await doc.send(new sdk.GetCommand({ TableName: table, Key: { pk: partitionOf(collection, actual), sk: id }, ConsistentRead: true }));
        return result.Item || null;
    }

    /**
     * Reads items by key, strongly consistent, 100 at a time.
     *
     * @param {{ pk: string, sk: string }[]} keys The items.
     * @returns {Promise<Map<string, object>>} The items found, by `pk` and `sk`.
     */
    async function batchRead(keys) {
        const found = new Map();
        for (let i = 0; i < keys.length; i += BATCH_GET) {
            let request = { Keys: keys.slice(i, i + BATCH_GET).map((key) => ({ pk: key.pk, sk: key.sk })), ConsistentRead: true };
            for (let attempt = 0; request; attempt++) {
                const result = await doc.send(new sdk.BatchGetCommand({ RequestItems: { [table]: request } }));
                for (const item of (result.Responses && result.Responses[table]) || []) found.set(item.pk + '\u0000' + item.sk, item);
                request = result.UnprocessedKeys && result.UnprocessedKeys[table];
                if (request && attempt >= 5) throw new Error('DynamoDB would not return every document after 6 tries.');
                if (request) await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
            }
        }
        return found;
    }

    const rows = {
        async insert(collection, owner, fields) {
            const at = now();
            const id = newId();
            const item = {
                pk: partitionOf(collection, owner), sk: id, owner_id: owner, created_at: at, updated_at: at, f: fields,
                gsi1pk: indexOf(collection), gsi1sk: pad(at) + '#' + id
            };
            await doc.send(new sdk.TransactWriteCommand({
                TransactItems: [
                    { Put: { TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(pk)' } },
                    { Put: { TableName: table, Item: { pk: pointerOf(collection, id), sk: 'i', owner_id: owner }, ConditionExpression: 'attribute_not_exists(pk)' } }
                ]
            }));
            return fromItem(item);
        },

        async get(collection, owner, id) {
            const item = await readItem(collection, owner, id);
            return item ? fromItem(item) : null;
        },

        async list(collection, owner, where, limit) {
            const matches = (item) => where.every(([key, value]) => same(item.f[key], value));
            const sorted = (a, b) => b.created_at - a.created_at || (a.sk < b.sk ? 1 : -1);
            if (owner !== null) {
                const found = [];
                let startKey;
                do {
                    const page = await doc.send(new sdk.QueryCommand({
                        TableName: table, ConsistentRead: true, KeyConditionExpression: 'pk = :p',
                        ExpressionAttributeValues: { ':p': partitionOf(collection, owner) }, ExclusiveStartKey: startKey
                    }));
                    for (const item of page.Items || []) {
                        if (matches(item)) found.push(item);
                    }
                    startKey = page.LastEvaluatedKey;
                } while (startKey);
                found.sort(sorted);
                return found.slice(0, limit).map(fromItem);
            }
            // Across owners: walk the index newest first, re-read each page consistently, and stop at `limit` matches.
            const found = [];
            let startKey;
            do {
                const page = await doc.send(new sdk.QueryCommand({
                    TableName: table, IndexName: 'gsi1', ScanIndexForward: false, KeyConditionExpression: 'gsi1pk = :p',
                    ExpressionAttributeValues: { ':p': indexOf(collection) }, ExclusiveStartKey: startKey
                }));
                const fresh = await batchRead((page.Items || []).map((item) => ({ pk: item.pk, sk: item.sk })));
                for (const entry of page.Items || []) {
                    const item = fresh.get(entry.pk + '\u0000' + entry.sk);
                    if (item && matches(item)) found.push(item);
                }
                startKey = found.length >= limit ? undefined : page.LastEvaluatedKey;
            } while (startKey);
            // The index orders by creation time to the millisecond; the id breaks ties the same way the other providers do.
            found.sort(sorted);
            return found.slice(0, limit).map(fromItem);
        },

        async update(collection, owner, id, patch) {
            const item = await readItem(collection, owner, id);
            if (!item) return null;
            const names = { '#f': 'f', '#u': 'updated_at' };
            const values = { ':u': Math.max(now(), Number(item.created_at)) };
            const sets = ['#u = :u'];
            const keys = Object.keys(patch);
            for (let i = 0; i < keys.length; i++) {
                names['#k' + i] = keys[i];
                values[':v' + i] = patch[keys[i]];
                sets.push('#f.#k' + i + ' = :v' + i);
            }
            try {
                const result = await doc.send(new sdk.UpdateCommand({
                    TableName: table, Key: { pk: item.pk, sk: id }, UpdateExpression: 'SET ' + sets.join(', '),
                    ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeNames: names, ExpressionAttributeValues: values, ReturnValues: 'ALL_NEW'
                }));
                return fromItem(result.Attributes);
            } catch (err) {
                // Removed between the read and the write.
                if (conditionFailed(err)) return null;
                throw err;
            }
        },

        async remove(collection, owner, id) {
            const item = await readItem(collection, owner, id);
            if (!item) return false;
            try {
                await doc.send(new sdk.TransactWriteCommand({
                    TransactItems: [
                        { Delete: { TableName: table, Key: { pk: item.pk, sk: id }, ConditionExpression: 'attribute_exists(pk)' } },
                        { Delete: { TableName: table, Key: { pk: pointerOf(collection, id), sk: 'i' } } }
                    ]
                }));
                return true;
            } catch (err) {
                // Removed by someone else between the read and the write.
                if (conditionFailed(err)) return false;
                throw err;
            }
        }
    };

    const views = buildViews(rows);
    return {
        scope: views.scope,
        system: views.system,
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
