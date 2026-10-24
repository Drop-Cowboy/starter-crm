import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { buildParameters, deploy, describeParameters, parseOptions, secretsNeeded, stackCommands } from './deploy-aws.mjs';
import { destroy, parseOptions as parseDestroyOptions } from './destroy-aws.mjs';

const OK = { status: 0, stdout: '', stderr: '' };
const NO_STACK = { status: 255, stdout: '', stderr: 'An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id starter-crm does not exist' };

/** A fake `aws`: answers by the first words of the command and records every call. */
function fakeAws(answers = {}) {
    const calls = [];
    const exec = (command, args) => {
        calls.push({ command, args });
        assert.equal(command, 'aws');
        const key = args.slice(0, 2).join(' ');
        const answer = answers[key] ?? answers[args[1]] ?? OK;
        return typeof answer === 'function' ? answer(args) : answer;
    };
    return { exec, calls };
}

const stackJson = (parameters, outputs = [], status = 'CREATE_COMPLETE') => ({
    status: 0,
    stdout: JSON.stringify({ Stacks: [{ StackStatus: status, Parameters: parameters, Outputs: outputs }] }),
    stderr: ''
});
const OUTPUTS = [
    { OutputKey: 'AppUrl', OutputValue: 'https://app.example.test' },
    { OutputKey: 'WebhookUrl', OutputValue: 'https://app.example.test/webhooks/dropcowboy' },
    { OutputKey: 'TableName', OutputValue: 'table-one' }
];
const SECRET_ENV = { DROPCOWBOY_API_KEY: 'key-value-1', DROPCOWBOY_API_SECRET: 'secret-value-2', DC_PASSCODE: 'a-long-passcode-3' };

describe('parseOptions', () => {
    it('reads values and flags', () => {
        const o = parseOptions(['--region', 'eu-west-1', '--redis=true', '--dry-run', '--max-tasks', '3']);
        assert.deepEqual(o, { region: 'eu-west-1', redis: 'true', 'dry-run': true, 'max-tasks': '3' });
    });

    it('refuses what the template would refuse, with the fix', () => {
        assert.throws(() => parseOptions(['--site-id', 'abc']), /must be a UUID/);
        assert.throws(() => parseOptions(['--stack-name', '1bad']), /must start with a letter/);
        assert.throws(() => parseOptions(['--auth-mode', 'nope']), /must be one of server, login/);
        assert.throws(() => parseOptions(['--max-tasks', '99']), /1 to 20/);
        assert.throws(() => parseOptions(['--subnet-ids', 'subnet-a']), /two or more/);
        assert.throws(() => parseOptions(['--bogus']), /Unknown option/);
        assert.throws(() => parseOptions(['--region']), /needs a value/);
        assert.throws(() => parseOptions(['stray']), /Unexpected argument/);
    });
});

describe('secretsNeeded', () => {
    it('asks for the Drop Cowboy credentials and the passcode in server mode', () => {
        assert.deepEqual(secretsNeeded({ authMode: 'server', identity: 'passcode' }).required, ['DropCowboyApiKey', 'DropCowboyApiSecret', 'Passcode']);
        assert.deepEqual(secretsNeeded({ authMode: 'server', identity: 'oidc' }).required, ['DropCowboyApiKey', 'DropCowboyApiSecret']);
    });

    it('asks for nothing in login mode', () => {
        assert.deepEqual(secretsNeeded({ authMode: 'login', identity: 'passcode' }).required, []);
    });
});

describe('buildParameters', () => {
    it('keeps the previous value of everything not named when the stack exists', () => {
        const list = buildParameters({ explicit: { Cpu: '1024' }, secrets: { Passcode: '', WebhookSecret: 'new-hook-secret' }, existing: ['Cpu', 'Passcode', 'SiteId', 'WebhookSecret'] });
        assert.deepEqual(list, [
            { ParameterKey: 'Cpu', ParameterValue: '1024' },
            { ParameterKey: 'WebhookSecret', ParameterValue: 'new-hook-secret' },
            { ParameterKey: 'Passcode', UsePreviousValue: true },
            { ParameterKey: 'SiteId', UsePreviousValue: true }
        ]);
    });

    it('sets only what is named for a new stack', () => {
        const list = buildParameters({ explicit: { SiteId: 'x' }, secrets: { Passcode: '' }, existing: null });
        assert.deepEqual(list, [{ ParameterKey: 'SiteId', ParameterValue: 'x' }]);
    });

    it('never prints a secret', () => {
        const lines = describeParameters([{ ParameterKey: 'Passcode', ParameterValue: 'hunter2-hunter2' }, { ParameterKey: 'Cpu', ParameterValue: '512' }, { ParameterKey: 'SiteId', UsePreviousValue: true }]);
        assert.equal(lines.join('\n').includes('hunter2'), false);
        assert.deepEqual(lines, ['  Passcode = (set, hidden)', '  Cpu = 512', '  SiteId = (unchanged)']);
    });
});

describe('stackCommands', () => {
    it('creates or updates, and waits for the matching state', () => {
        const create = stackCommands({ stackName: 's', region: 'us-east-1', exists: false, parametersFile: '/p.json', siteId: 'id' });
        assert.equal(create.change[1], 'create-stack');
        assert.equal(create.wait[2], 'stack-create-complete');
        const update = stackCommands({ stackName: 's', region: null, exists: true, parametersFile: '/p.json', siteId: 'id' });
        assert.equal(update.change[1], 'update-stack');
        assert.equal(update.wait[2], 'stack-update-complete');
        assert.equal(update.change.includes('--region'), false);
        assert.ok(update.change.includes('CAPABILITY_IAM'));
        assert.ok(update.change.includes('Key=starter-crm:stack,Value=s'));
    });
});

describe('deploy', () => {
    it('--dry-run makes no AWS call at all', async () => {
        const { exec, calls } = fakeAws();
        const lines = [];
        const result = await deploy({ 'dry-run': true }, { exec, env: {}, log: (l) => lines.push(l), interactive: false });
        assert.equal(result.dryRun, true);
        assert.equal(calls.length, 0);
        assert.ok(lines.join('\n').includes('Dry run'));
    });

    it('creates a new stack in the default VPC, keeps secrets off the command line, and deletes the parameter file', async () => {
        let parameters;
        let file;
        const { exec, calls } = fakeAws({
            'cloudformation describe-stacks': (() => {
                let n = 0;
                return () => (n++ === 0 ? NO_STACK : stackJson([], OUTPUTS));
            })(),
            'ec2 describe-vpcs': { status: 0, stdout: 'vpc-0aaa\n', stderr: '' },
            'ec2 describe-subnets': { status: 0, stdout: JSON.stringify(['subnet-a', 'subnet-b']), stderr: '' },
            'cloudformation create-stack': (args) => {
                file = args[args.indexOf('--parameters') + 1].replace('file://', '');
                parameters = JSON.parse(fs.readFileSync(file, 'utf8'));
                assert.equal(fs.statSync(file).mode & 0o077, 0, 'the parameter file is private to you');
                return OK;
            }
        });
        const lines = [];
        const result = await deploy({ yes: true, region: 'us-east-2' }, { exec, env: SECRET_ENV, log: (l) => lines.push(l), interactive: false });

        const byKey = Object.fromEntries(parameters.map((p) => [p.ParameterKey, p.ParameterValue]));
        assert.equal(byKey.VpcId, 'vpc-0aaa');
        assert.equal(byKey.SubnetIds, 'subnet-a,subnet-b');
        assert.equal(byKey.DropCowboyApiKey, 'key-value-1');
        assert.equal(byKey.Passcode, 'a-long-passcode-3');
        assert.match(byKey.SiteId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

        const everything = JSON.stringify(calls.map((c) => c.args)) + lines.join('\n');
        for (const secret of Object.values(SECRET_ENV)) assert.equal(everything.includes(secret), false, 'a secret reached a command line or the output');
        assert.equal(fs.existsSync(file), false, 'the parameter file is deleted');
        assert.ok(calls.some((c) => c.args[0] === 'cloudformation' && c.args[1] === 'wait' && c.args[2] === 'stack-create-complete'));
        assert.equal(result.appUrl, 'https://app.example.test');
        assert.ok(lines.join('\n').includes('Webhook URL: https://app.example.test/webhooks/dropcowboy'));
        assert.ok(lines.join('\n').includes('create a webhook in Drop Cowboy'));
    });

    it('updates an existing stack and keeps its values, its site id and its network', async () => {
        let parameters;
        const previous = ['SiteId', 'VpcId', 'SubnetIds', 'AuthMode', 'Identity', 'DropCowboyApiKey', 'DropCowboyApiSecret', 'Passcode', 'WebhookSecret', 'Cpu']
            .map((ParameterKey) => ({ ParameterKey, ParameterValue: ParameterKey === 'AuthMode' ? 'server' : ParameterKey === 'Identity' ? 'passcode' : '****' }));
        const { exec, calls } = fakeAws({
            'cloudformation describe-stacks': stackJson(previous, OUTPUTS, 'UPDATE_COMPLETE'),
            'cloudformation update-stack': (args) => {
                parameters = JSON.parse(fs.readFileSync(args[args.indexOf('--parameters') + 1].replace('file://', ''), 'utf8'));
                return OK;
            }
        });
        await deploy({ yes: true, cpu: '1024' }, { exec, env: {}, log: () => {}, interactive: false });
        assert.equal(calls.some((c) => c.args[0] === 'ec2'), false, 'an update does not look the network up again');
        const get = (key) => parameters.find((p) => p.ParameterKey === key);
        assert.deepEqual(get('Cpu'), { ParameterKey: 'Cpu', ParameterValue: '1024' });
        assert.deepEqual(get('SiteId'), { ParameterKey: 'SiteId', UsePreviousValue: true });
        assert.deepEqual(get('Passcode'), { ParameterKey: 'Passcode', UsePreviousValue: true });
    });

    it('treats "No updates are to be performed" as success without waiting', async () => {
        const previous = [{ ParameterKey: 'SiteId', ParameterValue: 'x' }, { ParameterKey: 'AuthMode', ParameterValue: 'login' }];
        const { exec, calls } = fakeAws({
            'cloudformation describe-stacks': stackJson(previous, OUTPUTS, 'UPDATE_COMPLETE'),
            'cloudformation update-stack': { status: 254, stdout: '', stderr: 'An error occurred (ValidationError): No updates are to be performed.' }
        });
        const lines = [];
        await deploy({ yes: true }, { exec, env: {}, log: (l) => lines.push(l), interactive: false });
        assert.ok(lines.join('\n').includes('Nothing to change'));
        assert.equal(calls.some((c) => c.args[1] === 'wait'), false);
    });

    it('stops with what is missing when a required secret is absent and nobody can be asked', async () => {
        const { exec, calls } = fakeAws({ 'cloudformation describe-stacks': NO_STACK });
        await assert.rejects(
            deploy({ yes: true, 'vpc-id': 'vpc-1', 'subnet-ids': 'a,b' }, { exec, env: {}, log: () => {}, interactive: false }),
            /Missing DROPCOWBOY_API_KEY, DROPCOWBOY_API_SECRET, DC_PASSCODE/
        );
        assert.equal(calls.some((c) => c.args[1] === 'create-stack'), false);
    });

    it('refuses a short passcode and characters the template would reject', async () => {
        const { exec } = fakeAws({ 'cloudformation describe-stacks': NO_STACK });
        const run = (env) => deploy({ yes: true, 'vpc-id': 'vpc-1', 'subnet-ids': 'a,b' }, { exec, env, log: () => {}, interactive: false });
        await assert.rejects(run({ ...SECRET_ENV, DC_PASSCODE: 'short' }), /12 or more characters/);
        await assert.rejects(run({ ...SECRET_ENV, DROPCOWBOY_API_KEY: 'has space' }), /must not contain quotes/);
    });

    it('will not touch a stack that is mid-change', async () => {
        const { exec } = fakeAws({ 'cloudformation describe-stacks': stackJson([], OUTPUTS, 'UPDATE_IN_PROGRESS') });
        await assert.rejects(deploy({ yes: true }, { exec, env: SECRET_ENV, log: () => {}, interactive: false }), /UPDATE_IN_PROGRESS/);
    });

    it('explains a failed create with what the CLI said', async () => {
        const { exec } = fakeAws({
            'cloudformation describe-stacks': NO_STACK,
            'cloudformation create-stack': { status: 254, stdout: '', stderr: 'AccessDenied: not allowed' }
        });
        await assert.rejects(
            deploy({ yes: true, 'vpc-id': 'vpc-1', 'subnet-ids': 'a,b' }, { exec, env: SECRET_ENV, log: () => {}, interactive: false }),
            /create-stack failed: AccessDenied/
        );
    });
});

describe('destroy', () => {
    const withTable = (retain) => stackJson([{ ParameterKey: 'RetainData', ParameterValue: retain }], OUTPUTS);

    it('--dry-run makes no AWS call', async () => {
        const { exec, calls } = fakeAws();
        await destroy({ 'dry-run': true }, { exec, env: {}, log: () => {}, interactive: false });
        assert.equal(calls.length, 0);
    });

    it('says so when there is no stack', async () => {
        const { exec, calls } = fakeAws({ 'cloudformation describe-stacks': NO_STACK });
        const result = await destroy({ yes: true }, { exec, env: {}, log: () => {}, interactive: false });
        assert.equal(result.deleted, false);
        assert.equal(calls.some((c) => c.args[1] === 'delete-stack'), false);
    });

    it('needs --yes without a terminal', async () => {
        const { exec } = fakeAws({ 'cloudformation describe-stacks': withTable('true') });
        await assert.rejects(destroy({}, { exec, env: {}, log: () => {}, interactive: false }), /Pass --yes/);
    });

    it('deletes after the stack name is typed, and says the retained table stays', async () => {
        const { exec, calls } = fakeAws({ 'cloudformation describe-stacks': withTable('true') });
        const lines = [];
        const result = await destroy({ region: 'us-east-1' }, { exec, env: {}, log: (l) => lines.push(l), interactive: true, confirmName: async (name) => name === 'starter-crm' });
        assert.equal(result.deleted, true);
        assert.ok(calls.some((c) => c.args[1] === 'delete-stack' && c.args.includes('us-east-1')));
        assert.ok(calls.some((c) => c.args[1] === 'wait' && c.args[2] === 'stack-delete-complete'));
        assert.ok(lines.join('\n').includes('table-one is retained'));
    });

    it('does nothing when the name is not typed', async () => {
        const { exec, calls } = fakeAws({ 'cloudformation describe-stacks': withTable('true') });
        const result = await destroy({}, { exec, env: {}, log: () => {}, interactive: true, confirmName: async () => false });
        assert.equal(result.deleted, false);
        assert.equal(calls.some((c) => c.args[1] === 'delete-stack'), false);
    });

    it('says the table is deleted too when RetainData is false', async () => {
        const { exec } = fakeAws({ 'cloudformation describe-stacks': withTable('false') });
        const lines = [];
        await destroy({ yes: true }, { exec, env: {}, log: (l) => lines.push(l), interactive: false });
        assert.ok(lines.join('\n').includes('is deleted with the stack'));
    });

    it('checks its options', () => {
        assert.throws(() => parseDestroyOptions(['--stack-name', '9']), /must start with a letter/);
        assert.deepEqual(parseDestroyOptions(['--yes', '--region', 'x']), { yes: true, region: 'x' });
    });
});
