#!/usr/bin/env node
/**
 * `npm run destroy:aws` — deletes the CloudFormation stack that `npm run deploy:aws` made.
 *
 * Where it sits: starter root, next to deploy-aws.mjs. It deletes the service, the queues, the cache and the secret.
 * The DynamoDB table survives when the stack was deployed with `--retain-data true` (the default): CloudFormation
 * leaves a retained table behind, and so do you until you delete it yourself. The secret goes into Secrets Manager's
 * recovery window rather than vanishing at once.
 *
 *   npm run destroy:aws -- --stack-name starter-crm --region us-east-1
 *   npm run destroy:aws -- --dry-run
 *
 * CONTRACT.md: not part of the contract. HOSTING.md: "AWS ECS Express".
 * What a customer changes: nothing; pass options instead.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STACK_NAME, aws, describeStack, execFile, outputsOf, readArgs, regionArgs } from './lib/aws-stack.mjs';

export const HELP = `Deletes the Starter CRM stack that deploy:aws created.

  npm run destroy:aws -- [options]

Options:
  --stack-name <name>  The stack (default: starter-crm).
  --region <region>    The AWS region (default: the AWS CLI's own).
  --yes                Do not ask you to type the stack name. Required when there is no terminal.
  --dry-run            Print what would run and change nothing. No AWS calls are made.
`;

/**
 * Reads and checks the command line.
 *
 * @param {string[]} argv The arguments after the script name.
 * @returns {Record<string, string|boolean>} The options by name.
 * @throws {Error} With the fix in the message.
 */
export function parseOptions(argv) {
    const options = readArgs(argv, { values: ['stack-name', 'region'], flags: ['yes', 'dry-run', 'help'] });
    if (options['stack-name'] !== undefined && !STACK_NAME.test(options['stack-name'])) {
        throw new Error('--stack-name must start with a letter and use letters, digits and dashes (128 at most).');
    }
    return options;
}

/**
 * Asks you to type the stack name.
 *
 * @param {string} stackName The name that must be typed.
 * @returns {Promise<boolean>} True when it was typed exactly.
 */
async function typeNameToConfirm(stackName) {
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        return (await rl.question('Type the stack name to delete it (' + stackName + '): ')).trim() === stackName;
    } finally {
        rl.close();
    }
}

/**
 * Deletes the stack.
 *
 * @param {Record<string, string|boolean>} options The parsed options.
 * @param {object} [deps] Injected for tests.
 * @param {Function} [deps.exec] Runs a command: `(command, args) => { status, stdout, stderr }`.
 * @param {NodeJS.ProcessEnv} [deps.env] The environment.
 * @param {Function} [deps.confirmName] Asks for the stack name: `(name) => Promise<boolean>`.
 * @param {Function} [deps.log] Prints a line.
 * @param {boolean} [deps.interactive] Whether a person can answer.
 * @returns {Promise<{ deleted: boolean, dryRun?: boolean }>} What happened.
 */
export async function destroy(options, deps = {}) {
    const exec = deps.exec || execFile;
    const env = deps.env || process.env;
    const log = deps.log || ((line) => console.log(line));
    const interactive = deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const stackName = options['stack-name'] || 'starter-crm';
    const region = options.region || env.AWS_REGION || env.AWS_DEFAULT_REGION || null;

    if (options['dry-run']) {
        log('Dry run: nothing was changed and AWS was not called. This is what a real run does:');
        log('  aws cloudformation describe-stacks --stack-name ' + stackName);
        log('  aws cloudformation delete-stack --stack-name ' + stackName + (region ? ' --region ' + region : ''));
        log('  aws cloudformation wait stack-delete-complete --stack-name ' + stackName + (region ? ' --region ' + region : ''));
        return { deleted: false, dryRun: true };
    }

    const stack = describeStack(exec, stackName, region);
    if (!stack) {
        log('There is no stack named ' + stackName + (region ? ' in ' + region : '') + '. Nothing to delete.');
        return { deleted: false };
    }
    if (/IN_PROGRESS$/.test(stack.StackStatus)) {
        throw new Error('Stack ' + stackName + ' is ' + stack.StackStatus + '. Wait for it to finish, then run this again.');
    }

    const outputs = outputsOf(stack);
    const retained = (stack.Parameters || []).find((p) => p.ParameterKey === 'RetainData');
    const keepsTable = !retained || retained.ParameterValue !== 'false';
    log('This deletes stack ' + stackName + ': the service, its queues, its cache and its secret.');
    if (keepsTable) {
        log('The DynamoDB table ' + (outputs.TableName || '') + ' is retained, with all its data. Delete it yourself when you no longer need it.');
    } else {
        log('The DynamoDB table ' + (outputs.TableName || '') + ' is deleted with the stack, and so is its data.');
    }
    log('The Secrets Manager secret is scheduled for deletion and stays recoverable for its recovery window.');

    if (!options.yes) {
        if (!interactive) throw new Error('There is no terminal to ask on. Pass --yes to delete without asking.');
        if (!(await (deps.confirmName || typeNameToConfirm)(stackName))) {
            log('Stopped. Nothing was changed.');
            return { deleted: false };
        }
    }

    aws(exec, ['cloudformation', 'delete-stack', '--stack-name', stackName, ...regionArgs(region)]);
    log('Waiting for CloudFormation to finish deleting.');
    aws(exec, ['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', stackName, ...regionArgs(region)]);
    log('Deleted.');
    return { deleted: true };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    try {
        const argv = process.argv.slice(2);
        if (argv.includes('--help') || argv.includes('-h')) {
            console.log(HELP);
        } else {
            await destroy(parseOptions(argv));
        }
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}
