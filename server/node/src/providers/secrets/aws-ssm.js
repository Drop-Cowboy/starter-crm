/**
 * The `aws-ssm` secrets provider: AWS Systems Manager Parameter Store, one path.
 *
 * Where it sits: `DC_SECRETS=aws-ssm`. Each starter secret is a parameter named `<path>/<NAME>`, for example
 * `/starter-crm/DROPCOWBOY_API_KEY`, created as a `SecureString`. The provider reads the path with decryption and
 * keeps only the names the starter asks for. The AWS SDK finds its credentials itself, so on ECS the task role
 * needs `ssm:GetParametersByPath` on that path (and `kms:Decrypt` when you use your own key).
 *
 * CONTRACT.md: "Providers" (secrets).
 * Env: DC_AWS_SSM_PATH (such as /starter-crm) and AWS_REGION. What a customer changes: nothing.
 */

import { clientConfig, describeAwsError, validateAws } from '../../aws.js';
import { problem } from '../../problems.js';
import { pick } from './http.js';

export const name = 'aws-ssm';
export const configKeys = ['DC_AWS_SSM_PATH', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ENDPOINT_URL', 'AWS_ENDPOINT_URL_SSM'];

/** What a Parameter Store path may look like: `/` then segments of letters, digits and `_.-`. */
const SSM_PATH = /^\/([A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;

/**
 * Checks the path and the region.
 *
 * @param {NodeJS.ProcessEnv} env The merged environment.
 * @returns {object[]} Boot problems.
 */
export function validate(env) {
    const problems = validateAws(env, 'DC_SECRETS=aws-ssm', 'SSM');
    const path = typeof env.DC_AWS_SSM_PATH === 'string' ? env.DC_AWS_SSM_PATH.trim().replace(/\/+$/, '') : '';
    if (path === '') {
        problems.push(problem('missing_aws_ssm_path', 'DC_SECRETS=aws-ssm needs DC_AWS_SSM_PATH.',
            'Set DC_AWS_SSM_PATH to the path that holds one SecureString parameter per secret, for example /starter-crm.'));
    } else if (!SSM_PATH.test(path)) {
        problems.push(problem('invalid_aws_ssm_path', 'DC_AWS_SSM_PATH must start with / and use letters, digits, "_", "." and "-" (got "' + path + '").',
            'Set it to a path such as /starter-crm or /apps/starter-crm.'));
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
    const sdk = await import('@aws-sdk/client-ssm');
    const client = ctx.client || new sdk.SSMClient(clientConfig(ctx.env, 'SSM'));
    const path = ctx.env.DC_AWS_SSM_PATH.trim().replace(/\/+$/, '');
    let lastNames = [];

    async function read(names) {
        const all = {};
        let token;
        try {
            do {
                const page = await client.send(new sdk.GetParametersByPathCommand({ Path: path, Recursive: false, WithDecryption: true, NextToken: token }));
                for (const parameter of page.Parameters || []) {
                    const leaf = String(parameter.Name).slice(path.length + 1);
                    if (leaf !== '' && !leaf.includes('/')) all[leaf] = parameter.Value;
                }
                token = page.NextToken;
            } while (token);
        } catch (err) {
            throw new Error(describeAwsError('AWS Parameter Store', err) + ' for "' + path + '"', { cause: err });
        }
        return pick(all, names);
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
