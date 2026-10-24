/**
 * The `aws-secrets-manager` secrets provider: AWS Secrets Manager, one JSON secret.
 *
 * Where it sits: `DC_SECRETS=aws-secrets-manager`. One secret holds a JSON object with one field per starter
 * secret (`DROPCOWBOY_API_KEY`, and so on); the provider reads its current version and keeps only the names the
 * starter asks for. The AWS SDK finds its credentials itself, so on ECS the task role needs
 * `secretsmanager:GetSecretValue` on that one secret and nothing else.
 *
 * CONTRACT.md: "Providers" (secrets).
 * Env: DC_AWS_SECRET_ID (the secret's name or ARN) and AWS_REGION. What a customer changes: nothing.
 */

import { clientConfig, describeAwsError, validateAws } from '../../aws.js';
import { problem } from '../../problems.js';
import { pick } from './http.js';

export const name = 'aws-secrets-manager';
export const configKeys = ['DC_AWS_SECRET_ID', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_SECRETS_MANAGER'];

/**
 * Checks the secret id and the region.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    const problems = validateAws(env, 'DC_SECRETS=aws-secrets-manager', 'SECRETS_MANAGER');
    if (typeof env.DC_AWS_SECRET_ID !== 'string' || env.DC_AWS_SECRET_ID.trim() === '') {
        problems.push(problem('missing_aws_secret_id', 'DC_SECRETS=aws-secrets-manager needs DC_AWS_SECRET_ID.',
            'Set DC_AWS_SECRET_ID to the name or ARN of a secret whose value is a JSON object, such as {"DROPCOWBOY_API_KEY":"..."}.'));
    }
    return problems;
}

/**
 * Creates the provider.
 *
 * @param {{ env: NodeJS.ProcessEnv, client?: { send: Function } }} ctx Provider context; `client` is replaced in tests.
 * @returns {Promise<{ load: (names: string[]) => Promise<Record<string, string>>, refresh: () => Promise<Record<string, string>> }>}
 *   The instance.
 */
export async function create(ctx) {
    const sdk = await import('@aws-sdk/client-secrets-manager');
    const client = ctx.client || new sdk.SecretsManagerClient(clientConfig(ctx.env, 'SECRETS_MANAGER'));
    const secretId = ctx.env.DC_AWS_SECRET_ID.trim();
    let lastNames = [];

    async function read(names) {
        let result;
        try {
            result = await client.send(new sdk.GetSecretValueCommand({ SecretId: secretId }));
        } catch (err) {
            // The id is a setting, not a secret, so naming it makes a typo or a missing permission easy to see.
            throw new Error(describeAwsError('AWS Secrets Manager', err) + ' for "' + secretId + '"', { cause: err });
        }
        let data;
        try {
            data = JSON.parse(result.SecretString || '');
        } catch {
            throw new Error('The secret "' + secretId + '" is not a JSON object of NAME: value pairs.');
        }
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('The secret "' + secretId + '" is not a JSON object of NAME: value pairs.');
        }
        return pick(data, names);
    }

    return {
        async load(names) {
            lastNames = names;
            return read(names);
        },
        async refresh() {
            return read(lastNames);
        }
    };
}
