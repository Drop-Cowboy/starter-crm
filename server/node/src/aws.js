/**
 * Shared AWS plumbing for the DynamoDB store and data provider, the SQS webhook mode and the AWS secrets providers.
 *
 * Where it sits: every provider that talks to AWS reads its region, endpoint and table name through here, so they agree
 * on the environment variables, the table's shape and the TLS rule.
 *
 * Credentials are never read here: the AWS SDK finds them itself (an ECS task role, a profile, or the
 * `AWS_ACCESS_KEY_ID` pair). The starter never asks for an access key in its own settings.
 *
 * The one table: the store (events) and the data provider (module documents) share a single DynamoDB table with a
 * string partition key `pk`, a string sort key `sk`, two global secondary indexes (`gsi1`, `gsi2`, each a string
 * `gsi1pk`/`gsi1sk`, `gsi2pk`/`gsi2sk`) and a time-to-live attribute `expires_at`. `TABLE_SPEC` below is that shape;
 * the CloudFormation template creates the same table, and a test compares the two so they cannot drift.
 *
 * CONTRACT.md: "Providers" (store, data, secrets, webhooks).
 * Env: AWS_REGION, AWS_ENDPOINT_URL (a local stand-in), DC_DYNAMODB_TABLE, DC_DYNAMODB_AUTO_CREATE. What a customer changes: nothing.
 */

import { problem } from './problems.js';
import { allowsPlaintext } from './tls.js';

/** The names a table may have: DynamoDB's own rule, 3 to 255 letters, digits, underscore, dot and dash. */
const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;

/** Hosts a plain-HTTP endpoint is accepted on in production: this machine only. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/** The table's shape, as `CreateTable` takes it. The CloudFormation template must match it. */
export const TABLE_SPEC = Object.freeze({
    keys: Object.freeze([{ name: 'pk', type: 'HASH' }, { name: 'sk', type: 'RANGE' }]),
    indexes: Object.freeze([
        { name: 'gsi1', hash: 'gsi1pk', range: 'gsi1sk' },
        { name: 'gsi2', hash: 'gsi2pk', range: 'gsi2sk' }
    ]),
    ttlAttribute: 'expires_at'
});

/**
 * Reads the AWS region.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {string|null} `AWS_REGION`, else `AWS_DEFAULT_REGION`, else null.
 */
export function awsRegion(env) {
    for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION']) {
        if (typeof env[key] === 'string' && env[key].trim() !== '') return env[key].trim();
    }
    return null;
}

/**
 * Reads the endpoint override a local stand-in (dynamodb-local, ElasticMQ) is reached on.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @param {string} service The SDK's service suffix, such as `DYNAMODB` or `SQS`.
 * @returns {string|null} The service-specific `AWS_ENDPOINT_URL_<SERVICE>`, else `AWS_ENDPOINT_URL`, else null.
 */
export function awsEndpoint(env, service) {
    for (const key of ['AWS_ENDPOINT_URL_' + service, 'AWS_ENDPOINT_URL']) {
        if (typeof env[key] === 'string' && env[key].trim() !== '') return env[key].trim();
    }
    return null;
}

/**
 * Checks that a region is set and, in production, that no endpoint override sends traffic over plain HTTP.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @param {string} needs What needs AWS, for the message, such as `DC_STORE=dynamodb`.
 * @param {string} service The SDK's service suffix, such as `DYNAMODB`.
 * @returns {object[]} Boot problems (none when the settings are fine).
 */
export function validateAws(env, needs, service) {
    const problems = [];
    if (!awsRegion(env)) {
        problems.push(problem('missing_aws_region', needs + ' needs AWS_REGION.',
            'Set AWS_REGION to the region your resources are in, such as us-east-1. ECS sets it for you.'));
    }
    const endpoint = awsEndpoint(env, service);
    if (endpoint) {
        let url = null;
        try {
            url = new URL(endpoint);
        } catch {
            problems.push(problem('invalid_aws_endpoint', 'AWS_ENDPOINT_URL is not a URL (got "' + endpoint + '").',
                'Leave it unset to use AWS, or set it to the address of a local stand-in such as http://127.0.0.1:8000.'));
        }
        if (url && env.DC_ENV === 'production' && url.protocol !== 'https:' && !LOCAL_HOSTS.includes(url.hostname) && !allowsPlaintext(env)) {
            problems.push(problem('insecure_aws_endpoint', 'AWS_ENDPOINT_URL must use https:// in production.',
                'Unset AWS_ENDPOINT_URL to use AWS, or use https://. Localhost is exempt, and so is a private network you control when DC_INSECURE_PRIVATE_SERVICES=on.'));
        }
    }
    return problems;
}

/**
 * Checks the table name.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validateTable(env) {
    const name = dynamoTable(env);
    if (!TABLE_NAME.test(name)) {
        return [problem('invalid_dynamodb_table', 'DC_DYNAMODB_TABLE is not a valid table name (got "' + name + '").',
            'Use 3 to 255 letters, digits, underscores, dots and dashes, or leave it unset for starter-crm.')];
    }
    return [];
}

/**
 * The table the store and data provider use.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {string} `DC_DYNAMODB_TABLE`, default `starter-crm`.
 */
export function dynamoTable(env) {
    const raw = env.DC_DYNAMODB_TABLE;
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : 'starter-crm';
}

/**
 * Whether the server may create the table when it is missing.
 *
 * Off by default: the CloudFormation template creates the table, and a task role that can create tables is more
 * permission than a running server needs. Turn it on for a local stand-in.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {boolean} True for `on`, `1` or `true`.
 */
export function autoCreate(env) {
    return ['on', '1', 'true'].includes(String(env.DC_DYNAMODB_AUTO_CREATE || '').trim().toLowerCase());
}

/**
 * The options every AWS SDK client here is built with.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @param {string} service The SDK's service suffix, such as `DYNAMODB`, `SQS`, `SECRETS_MANAGER` or `SSM`.
 * @returns {{ region?: string, endpoint?: string, maxAttempts: number, credentials?: object }} The client config. Credentials in
 *   the merged environment (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`) are passed on, because the SDK
 *   reads only the process environment, not `.env`; otherwise the SDK finds them (the ECS task role).
 */
export function clientConfig(env, service) {
    const endpoint = awsEndpoint(env, service);
    const config = { maxAttempts: 3 };
    const region = awsRegion(env);
    if (region) config.region = region;
    if (endpoint) config.endpoint = endpoint;
    const accessKeyId = String(env.AWS_ACCESS_KEY_ID || '').trim();
    const secretAccessKey = String(env.AWS_SECRET_ACCESS_KEY || '').trim();
    if (accessKeyId && secretAccessKey) {
        config.credentials = { accessKeyId, secretAccessKey };
        const sessionToken = String(env.AWS_SESSION_TOKEN || '').trim();
        if (sessionToken) config.credentials.sessionToken = sessionToken;
    }
    return config;
}

/**
 * Says what went wrong with an AWS call without echoing anything the call carried.
 *
 * @param {string} label The service, such as `AWS Secrets Manager`.
 * @param {any} err What the SDK threw.
 * @returns {string} For example `AWS Secrets Manager answered HTTP 403 (AccessDeniedException)`, or `... could not be reached`.
 */
export function describeAwsError(label, err) {
    const status = err && err.$metadata && err.$metadata.httpStatusCode;
    if (status) return label + ' answered HTTP ' + status + (err.name && err.name !== 'Error' ? ' (' + err.name + ')' : '');
    return label + ' could not be reached' + (err && err.code ? ' (' + err.code + ')' : '');
}

/**
 * Opens a DynamoDB document client.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {Promise<{ doc: import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient, raw: import('@aws-sdk/client-dynamodb').DynamoDBClient, sdk: object }>}
 *   The document client (plain JavaScript values in and out), the low-level client, and the SDK's command classes.
 */
export async function connectDynamo(env) {
    // The SDK is only needed when a DynamoDB provider is chosen, so it is not imported at the top of the file.
    const low = await import('@aws-sdk/client-dynamodb');
    const lib = await import('@aws-sdk/lib-dynamodb');
    const raw = new low.DynamoDBClient(clientConfig(env, 'DYNAMODB'));
    const doc = lib.DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
    return { doc, raw, sdk: { ...low, ...lib } };
}

/**
 * Creates the table (and waits until it is ready) when it does not exist and `DC_DYNAMODB_AUTO_CREATE` is on.
 *
 * @param {{ raw: object, sdk: object }} client What `connectDynamo()` returned.
 * @param {string} table The table name.
 * @param {boolean} create Whether this server may create it.
 * @returns {Promise<void>}
 * @throws {Error} When the table is missing and may not be created, naming the setting that fixes it.
 */
export async function ensureTable(client, table, create) {
    const { raw, sdk } = client;
    try {
        await raw.send(new sdk.DescribeTableCommand({ TableName: table }));
        return;
    } catch (err) {
        if (!err || err.name !== 'ResourceNotFoundException') throw err;
        if (!create) {
            throw new Error('The DynamoDB table "' + table + '" does not exist. Create it with the CloudFormation template (deploy/aws), or set DC_DYNAMODB_AUTO_CREATE=on to let the server create it.', { cause: err });
        }
    }
    const attributes = new Set();
    for (const key of TABLE_SPEC.keys) attributes.add(key.name);
    for (const index of TABLE_SPEC.indexes) {
        attributes.add(index.hash);
        attributes.add(index.range);
    }
    await raw.send(new sdk.CreateTableCommand({
        TableName: table,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [...attributes].map((name) => ({ AttributeName: name, AttributeType: 'S' })),
        KeySchema: TABLE_SPEC.keys.map((key) => ({ AttributeName: key.name, KeyType: key.type })),
        GlobalSecondaryIndexes: TABLE_SPEC.indexes.map((index) => ({
            IndexName: index.name,
            KeySchema: [{ AttributeName: index.hash, KeyType: 'HASH' }, { AttributeName: index.range, KeyType: 'RANGE' }],
            Projection: { ProjectionType: 'ALL' }
        }))
    }));
    await sdk.waitUntilTableExists({ client: raw, maxWaitTime: 60 }, { TableName: table });
    try {
        await raw.send(new sdk.UpdateTimeToLiveCommand({ TableName: table, TimeToLiveSpecification: { Enabled: true, AttributeName: TABLE_SPEC.ttlAttribute } }));
    } catch {
        // Some local stand-ins do not implement TTL; the store prunes expired events itself, so the table works without it.
    }
}

/**
 * A fixed-width sort-key piece for a time, so keys sort the way the times do.
 *
 * @param {number} ms Epoch milliseconds (0 up to 9999999999999).
 * @returns {string} The number as 13 digits, left-padded with zeros.
 */
export function pad(ms) {
    return String(Math.max(0, Math.floor(ms))).padStart(13, '0');
}
