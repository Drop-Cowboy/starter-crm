#!/usr/bin/env node
/**
 * `npm run deploy:aws` — deploys the Starter CRM to AWS with one CloudFormation stack.
 *
 * Where it sits: starter root. It wraps the AWS CLI around `deploy/aws/ecs-express.yaml` (Amazon ECS Express Mode,
 * a DynamoDB table, an SQS queue and optionally ElastiCache Serverless). It fills in your default VPC when you give
 * none, asks for the secrets without echoing them, creates the stack or updates it, waits, and prints the address and
 * the webhook URL.
 *
 * Secrets never appear on a command line: they go to the CLI in a temporary file (mode 0600) that is deleted
 * afterwards. Run it again with changed options to update the stack: anything you do not name keeps its value.
 *
 *   npm run deploy:aws -- --region us-east-1                  asks for what it needs
 *   npm run deploy:aws -- --dry-run                           prints what it would run, runs nothing
 *   DROPCOWBOY_API_KEY=... DROPCOWBOY_API_SECRET=... DC_PASSCODE=... npm run deploy:aws -- --yes
 *
 * CONTRACT.md: not part of the contract. HOSTING.md: "AWS ECS Express".
 * What a customer changes: nothing; pass options instead.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STACK_NAME, UUID, aws, describeStack, execFile, outputsOf, readArgs, regionArgs } from './lib/aws-stack.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE = path.join(ROOT, 'deploy', 'aws', 'ecs-express.yaml');

/** The secret template parameters, and the environment variable each one is read from. */
export const SECRETS = Object.freeze({
    DropCowboyApiKey: 'DROPCOWBOY_API_KEY',
    DropCowboyApiSecret: 'DROPCOWBOY_API_SECRET',
    WebhookSecret: 'DROPCOWBOY_WEBHOOK_SECRET',
    Passcode: 'DC_PASSCODE'
});

const VALUES = ['stack-name', 'region', 'image', 'site-id', 'auth-mode', 'identity', 'oidc-issuer', 'oidc-audience', 'public-url',
    'secrets-mode', 'webhook-mode', 'redis', 'retain-data', 'cpu', 'memory', 'max-tasks', 'vpc-id', 'subnet-ids'];
const FLAGS = ['dry-run', 'yes', 'help'];

const CHOICES = Object.freeze({
    'auth-mode': ['server', 'login'],
    identity: ['passcode', 'oidc'],
    'secrets-mode': ['inject', 'runtime'],
    'webhook-mode': ['sqs', 'store'],
    redis: ['true', 'false'],
    'retain-data': ['true', 'false'],
    cpu: ['256', '512', '1024', '2048', '4096']
});

/** The template parameter each option sets. */
const PARAMETER_OF = Object.freeze({
    image: 'ImageUri',
    'site-id': 'SiteId',
    'auth-mode': 'AuthMode',
    identity: 'Identity',
    'oidc-issuer': 'OidcIssuer',
    'oidc-audience': 'OidcAudience',
    'public-url': 'PublicUrl',
    'secrets-mode': 'SecretsMode',
    'webhook-mode': 'WebhookMode',
    redis: 'EnableRedis',
    'retain-data': 'RetainData',
    cpu: 'Cpu',
    memory: 'Memory',
    'max-tasks': 'MaxTasks',
    'vpc-id': 'VpcId'
});

export const HELP = `Deploys the Starter CRM to AWS (Amazon ECS Express Mode) with one CloudFormation stack.

  npm run deploy:aws -- [options]

Options (all optional):
  --stack-name <name>      The stack (default: starter-crm). Use another name for a second copy.
  --region <region>        The AWS region (default: the AWS CLI's own).
  --image <uri>            The container image. Pin a version tag; changing it later is a rollback or an upgrade.
  --site-id <uuid>         DROPCOWBOY_SITE_ID. Generated for a new stack; an existing stack keeps its own.
  --auth-mode <mode>       server (default) or login.
  --identity <name>        In server mode: passcode (default) or oidc.
  --oidc-issuer <url>      With --identity oidc.
  --oidc-audience <value>  With --identity oidc.
  --public-url <url>       DC_PUBLIC_URL. Leave it out on the first deploy: the printed AppUrl is the address.
  --secrets-mode <mode>    inject (default) or runtime (the app reads Secrets Manager and picks up rotations).
  --webhook-mode <mode>    sqs (default) or store.
  --redis <true|false>     Adds ElastiCache Serverless for live updates and rate limits (default false).
  --retain-data <t|f>      Keep the DynamoDB table when the stack is deleted (default true).
  --cpu <units>            256, 512 (default), 1024, 2048 or 4096.
  --memory <MiB>           Default 1024.
  --max-tasks <n>          Most tasks the service scales to (default 1).
  --vpc-id <id>            The VPC (default: your default VPC).
  --subnet-ids <a,b,...>   Two or more subnets in different zones (default: your default VPC's).
  --dry-run                Print what would run and change nothing. No AWS calls are made.
  --yes                    Do not ask: take secrets from the environment and go.

Secrets are read from DROPCOWBOY_API_KEY, DROPCOWBOY_API_SECRET, DROPCOWBOY_WEBHOOK_SECRET and DC_PASSCODE in the
environment, or asked for (hidden). The webhook secret does not exist until you create the webhook, so leave it blank
the first time and run this again with it afterwards.
`;

/**
 * Reads and checks the command line.
 *
 * @param {string[]} argv The arguments after the script name.
 * @returns {Record<string, string|boolean>} The options by name.
 * @throws {Error} With the fix in the message.
 */
export function parseOptions(argv) {
    const options = readArgs(argv, { values: VALUES, flags: FLAGS });
    if (options['stack-name'] !== undefined && !STACK_NAME.test(options['stack-name'])) {
        throw new Error('--stack-name must start with a letter and use letters, digits and dashes (128 at most).');
    }
    if (options['site-id'] !== undefined && !UUID.test(options['site-id'])) {
        throw new Error('--site-id must be a UUID. Leave it out to have one generated.');
    }
    for (const [name, allowed] of Object.entries(CHOICES)) {
        if (options[name] !== undefined && !allowed.includes(options[name])) {
            throw new Error('--' + name + ' must be one of ' + allowed.join(', ') + ' (got "' + options[name] + '").');
        }
    }
    if (options['max-tasks'] !== undefined && !/^([1-9]|1[0-9]|20)$/.test(options['max-tasks'])) {
        throw new Error('--max-tasks must be a whole number from 1 to 20.');
    }
    if (options.memory !== undefined && !/^[1-9][0-9]{2,5}$/.test(options.memory)) {
        throw new Error('--memory must be a number of MiB such as 1024.');
    }
    if (options['subnet-ids'] !== undefined && options['subnet-ids'].split(',').filter(Boolean).length < 2) {
        throw new Error('--subnet-ids needs two or more subnets, in different zones, separated by commas.');
    }
    return options;
}

/**
 * Which secrets this configuration needs.
 *
 * @param {{ authMode: string, identity: string }} shape The auth mode and identity that will be in force.
 * @returns {{ required: string[], optional: string[] }} Template parameter names.
 */
export function secretsNeeded({ authMode, identity }) {
    if (authMode === 'login') return { required: [], optional: ['WebhookSecret'] };
    const required = ['DropCowboyApiKey', 'DropCowboyApiSecret'];
    if (identity === 'passcode') required.push('Passcode');
    return { required, optional: ['WebhookSecret'] };
}

/**
 * Builds the `--parameters` list: what you set, plus the previous value of everything else when the stack exists.
 *
 * @param {object} input What is known.
 * @param {Record<string, string>} input.explicit Template parameters you set, by name.
 * @param {Record<string, string>} input.secrets Secret values by template parameter; blank ones are left out.
 * @param {string[]|null} input.existing The parameter names of the stack being updated, or null for a new stack.
 * @returns {{ ParameterKey: string, ParameterValue?: string, UsePreviousValue?: boolean }[]} CloudFormation parameters.
 */
export function buildParameters({ explicit, secrets, existing }) {
    const set = Object.assign({}, explicit);
    for (const [name, value] of Object.entries(secrets)) if (value !== '') set[name] = value;
    const list = Object.entries(set).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue }));
    if (existing) {
        for (const name of existing) if (!(name in set)) list.push({ ParameterKey: name, UsePreviousValue: true });
    }
    return list;
}

/**
 * Prints a parameter list for a person: secrets by whether they are set, never by value.
 *
 * @param {{ ParameterKey: string, ParameterValue?: string, UsePreviousValue?: boolean }[]} parameters The parameters.
 * @returns {string[]} One line each.
 */
export function describeParameters(parameters) {
    return parameters.map((p) => {
        const shown = p.UsePreviousValue ? '(unchanged)' : (p.ParameterKey in SECRETS ? '(set, hidden)' : p.ParameterValue);
        return '  ' + p.ParameterKey + ' = ' + shown;
    });
}

/**
 * Asks for a value without echoing it. Used only on a terminal.
 *
 * @param {string} question What to ask.
 * @returns {Promise<string>} What was typed.
 */
export function promptHidden(question) {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        process.stdout.write(question + ': ');
        let value = '';
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        const finish = () => {
            stdin.removeListener('data', onData);
            stdin.setRawMode(false);
            stdin.pause();
            process.stdout.write('\n');
            resolve(value);
        };
        const onData = (chunk) => {
            for (const char of chunk) {
                if (char === '\r' || char === '\n' || char === '\u0004') return finish();
                if (char === '\u0003') {
                    stdin.setRawMode(false);
                    process.stdout.write('\n');
                    process.exit(130);
                }
                if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
                else value += char;
            }
        };
        stdin.on('data', onData);
    });
}

/**
 * Asks a yes or no question on a terminal.
 *
 * @param {string} question What to ask.
 * @returns {Promise<boolean>} True for yes.
 */
export async function confirm(question) {
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await rl.question(question + ' [y/N] ');
        return /^y(es)?$/i.test(answer.trim());
    } finally {
        rl.close();
    }
}

/**
 * Finds the default VPC and its subnets, one per zone.
 *
 * @param {Function} exec The command runner.
 * @param {string|null} region The region.
 * @returns {{ vpcId: string, subnetIds: string[] }} The VPC and at least two subnets.
 * @throws {Error} When there is no default VPC or it has fewer than two subnets.
 */
export function findDefaultNetwork(exec, region) {
    const vpcId = aws(exec, ['ec2', 'describe-vpcs', '--filters', 'Name=is-default,Values=true', '--query', 'Vpcs[0].VpcId', '--output', 'text', ...regionArgs(region)]).trim();
    if (!vpcId || vpcId === 'None') {
        throw new Error('This region has no default VPC. Pass --vpc-id and --subnet-ids (two or more subnets in different zones).');
    }
    return { vpcId, subnetIds: subnetsOf(exec, vpcId, region) };
}

/**
 * Lists a VPC's default-for-zone subnets.
 *
 * @param {Function} exec The command runner.
 * @param {string} vpcId The VPC.
 * @param {string|null} region The region.
 * @returns {string[]} Subnet ids, at least two.
 * @throws {Error} When fewer than two are found.
 */
function subnetsOf(exec, vpcId, region) {
    const out = aws(exec, ['ec2', 'describe-subnets', '--filters', 'Name=vpc-id,Values=' + vpcId, 'Name=default-for-az,Values=true', '--query', 'Subnets[].SubnetId', '--output', 'json', ...regionArgs(region)]);
    const ids = JSON.parse(out);
    if (ids.length < 2) {
        throw new Error('VPC ' + vpcId + ' has fewer than two default subnets. Pass --subnet-ids with two or more subnets in different zones.');
    }
    return ids;
}

/**
 * The AWS CLI calls that create or update the stack, in order, with the parameter file as a placeholder.
 *
 * @param {object} input What to run.
 * @param {string} input.stackName The stack.
 * @param {string|null} input.region The region.
 * @param {boolean} input.exists True when the stack exists, so it is updated.
 * @param {string} input.parametersFile The parameter file.
 * @param {string} input.siteId The site id, for the tags.
 * @returns {{ change: string[], wait: string[] }} The change command and the wait command, as argument lists after `aws`.
 */
export function stackCommands({ stackName, region, exists, parametersFile, siteId }) {
    const verb = exists ? 'update-stack' : 'create-stack';
    const change = ['cloudformation', verb, '--stack-name', stackName, '--template-body', 'file://' + TEMPLATE,
        '--parameters', 'file://' + parametersFile, '--capabilities', 'CAPABILITY_IAM',
        '--tags', 'Key=starter-crm:site-id,Value=' + siteId, 'Key=starter-crm:stack,Value=' + stackName, ...regionArgs(region)];
    const wait = ['cloudformation', 'wait', exists ? 'stack-update-complete' : 'stack-create-complete', '--stack-name', stackName, ...regionArgs(region)];
    return { change, wait };
}

/**
 * Deploys the stack.
 *
 * @param {Record<string, string|boolean>} options The parsed options.
 * @param {object} [deps] Injected for tests.
 * @param {Function} [deps.exec] Runs a command: `(command, args) => { status, stdout, stderr }`.
 * @param {NodeJS.ProcessEnv} [deps.env] The environment.
 * @param {Function} [deps.ask] Asks for a hidden value: `(question) => Promise<string>`.
 * @param {Function} [deps.confirm] Asks yes or no.
 * @param {Function} [deps.log] Prints a line.
 * @param {boolean} [deps.interactive] Whether a person can answer.
 * @returns {Promise<{ appUrl?: string, webhookUrl?: string, dryRun?: boolean }>} What was deployed.
 */
export async function deploy(options, deps = {}) {
    const exec = deps.exec || execFile;
    const env = deps.env || process.env;
    const log = deps.log || ((line) => console.log(line));
    const interactive = deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const ask = deps.ask || promptHidden;
    const yes = Boolean(options.yes);
    const dryRun = Boolean(options['dry-run']);
    const stackName = options['stack-name'] || 'starter-crm';
    const region = options.region || env.AWS_REGION || env.AWS_DEFAULT_REGION || null;

    if (!fs.existsSync(TEMPLATE)) throw new Error('The template is missing: ' + TEMPLATE);

    let existing = null;
    if (!dryRun) {
        const found = describeStack(exec, stackName, region);
        if (found) {
            if (/IN_PROGRESS$/.test(found.StackStatus)) {
                throw new Error('Stack ' + stackName + ' is ' + found.StackStatus + '. Wait for it to finish, then run this again.');
            }
            existing = found;
        }
    }
    const previous = {};
    for (const item of existing?.Parameters || []) previous[item.ParameterKey] = item.ParameterValue;

    const explicit = {};
    for (const [option, parameter] of Object.entries(PARAMETER_OF)) {
        if (options[option] !== undefined) explicit[parameter] = String(options[option]);
    }
    if (!existing && explicit.SiteId === undefined) explicit.SiteId = crypto.randomUUID();
    const siteId = explicit.SiteId || previous.SiteId || '00000000-0000-4000-8000-000000000000';

    const authMode = explicit.AuthMode || previous.AuthMode || 'server';
    const identity = explicit.Identity || previous.Identity || 'passcode';
    const needed = secretsNeeded({ authMode, identity });

    const secrets = {};
    for (const name of [...needed.required, ...needed.optional]) {
        const fromEnv = (env[SECRETS[name]] || '').trim();
        if (fromEnv) {
            secrets[name] = fromEnv;
        } else if (existing && previous[name] !== undefined) {
            secrets[name] = '';
        } else if (interactive && !yes && !dryRun) {
            const optional = needed.optional.includes(name);
            secrets[name] = (await ask(SECRETS[name] + (optional ? ' (leave blank for now)' : ''))).trim();
        } else {
            secrets[name] = '';
        }
    }
    const missing = needed.required.filter((name) => secrets[name] === '' && !(existing && previous[name] !== undefined));
    if (missing.length > 0 && !dryRun) {
        throw new Error('Missing ' + missing.map((name) => SECRETS[name]).join(', ') + '. Set it in the environment, or run this on a terminal to be asked.');
    }
    if (secrets.Passcode && secrets.Passcode.length < 12) throw new Error('DC_PASSCODE must be 12 or more characters.');
    for (const [name, value] of Object.entries(secrets)) {
        if (/["\\\s]/.test(value)) throw new Error(SECRETS[name] + ' must not contain quotes, backslashes or spaces.');
    }

    let network = null;
    const needsNetwork = !existing || explicit.VpcId !== undefined || options['subnet-ids'] !== undefined;
    if (needsNetwork) {
        if (dryRun) {
            network = { vpcId: explicit.VpcId || '(your default VPC, looked up when you deploy)', subnetIds: options['subnet-ids'] ? options['subnet-ids'].split(',') : ['(its default subnets)'] };
        } else if (explicit.VpcId && options['subnet-ids']) {
            network = { vpcId: explicit.VpcId, subnetIds: options['subnet-ids'].split(',').filter(Boolean) };
        } else if (explicit.VpcId) {
            network = { vpcId: explicit.VpcId, subnetIds: subnetsOf(exec, explicit.VpcId, region) };
        } else if (options['subnet-ids']) {
            throw new Error('--subnet-ids needs --vpc-id as well.');
        } else {
            network = findDefaultNetwork(exec, region);
        }
        explicit.VpcId = network.vpcId;
        explicit.SubnetIds = network.subnetIds.join(',');
    }

    const parameters = buildParameters({
        explicit,
        secrets,
        existing: existing ? (existing.Parameters || []).map((p) => p.ParameterKey) : null
    });

    log((existing ? 'Updating' : 'Creating') + ' stack ' + stackName + (region ? ' in ' + region : '') + ':');
    for (const line of describeParameters(parameters)) log(line);

    const parametersFile = path.join(os.tmpdir(), 'starter-crm-parameters.json');
    const commands = stackCommands({ stackName, region, exists: Boolean(existing), parametersFile, siteId });
    if (dryRun) {
        log('');
        log('Dry run: nothing was changed and AWS was not called. This is what a real run does:');
        if (!existing) log('  aws ec2 describe-vpcs / describe-subnets   (only when --vpc-id is not given)');
        log('  aws cloudformation describe-stacks --stack-name ' + stackName);
        log('  aws ' + commands.change.join(' '));
        log('  aws ' + commands.wait.join(' '));
        log('  aws cloudformation describe-stacks --stack-name ' + stackName + '   (prints the address)');
        return { dryRun: true };
    }

    if (interactive && !yes && !(await (deps.confirm || confirm)('Go ahead?'))) {
        log('Stopped. Nothing was changed.');
        return {};
    }

    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'starter-crm-aws-'));
    fs.chmodSync(folder, 0o700);
    const file = path.join(folder, 'parameters.json');
    try {
        fs.writeFileSync(file, JSON.stringify(parameters), { mode: 0o600 });
        const real = stackCommands({ stackName, region, exists: Boolean(existing), parametersFile: file, siteId });
        const result = exec('aws', real.change);
        const noChange = result.status !== 0 && /No updates are to be performed/i.test(result.stderr || '');
        if (result.status !== 0 && !noChange) {
            throw new Error('aws cloudformation ' + (existing ? 'update-stack' : 'create-stack') + ' failed: ' + (result.stderr || result.stdout).trim());
        }
        if (noChange) {
            log('Nothing to change: the stack already has these values.');
        } else {
            log('Waiting for CloudFormation. The first deploy takes about ten minutes (more with --redis true).');
            aws(exec, real.wait);
        }
    } finally {
        fs.rmSync(folder, { recursive: true, force: true });
    }

    const stack = describeStack(exec, stackName, region);
    const outputs = outputsOf(stack || {});
    log('');
    log('Deployed.');
    log('  App:         ' + outputs.AppUrl);
    log('  Webhook URL: ' + outputs.WebhookUrl);
    log('');
    if (!secrets.WebhookSecret && !previous.WebhookSecret) {
        log('Next: create a webhook in Drop Cowboy that points at the Webhook URL, then run this again with its signing secret:');
        log('  DROPCOWBOY_WEBHOOK_SECRET=... npm run deploy:aws -- --stack-name ' + stackName + (region ? ' --region ' + region : '') + ' --yes');
    }
    log('Check it: npm run test:deployed -- --url ' + outputs.AppUrl);
    return { appUrl: outputs.AppUrl, webhookUrl: outputs.WebhookUrl };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    try {
        const argv = process.argv.slice(2);
        if (argv.includes('--help') || argv.includes('-h')) {
            console.log(HELP);
        } else {
            await deploy(parseOptions(argv));
        }
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}
