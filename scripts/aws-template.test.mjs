import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { TABLE_SPEC } from '../server/node/src/aws.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = path.join(ROOT, 'deploy', 'aws', 'ecs-express.yaml');
const CONTENT_CHECK = [
    path.resolve(ROOT, '..', '..', '..', 'docs', 'examples', 'api', 'scripts', 'public-content-check.mjs'),
    path.join(ROOT, '.github', 'scripts', 'public-content-check.mjs')
].find((candidate) => fs.existsSync(candidate));

/** cfn-lint is a Python tool; its own interpreter also gives us a YAML reader that understands `!Ref` and friends. */
function cfnLint() {
    const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['cfn-lint'], { encoding: 'utf8' });
    if (found.status !== 0) return null;
    const bin = found.stdout.split(/\r?\n/)[0].trim();
    const shebang = fs.readFileSync(bin, 'utf8').split('\n', 1)[0];
    const interpreter = shebang.startsWith('#!') ? shebang.slice(2).trim().split(/\s+/)[0] : null;
    return { bin, interpreter: interpreter && fs.existsSync(interpreter) ? interpreter : null };
}
const lint = cfnLint();
const missing = lint ? null : 'cfn-lint is not installed (pip install cfn-lint)';
if (missing && process.env.CI) throw new Error(missing + '. CI must have it.');

const READ_YAML = `
import json, sys, yaml

class Loader(yaml.SafeLoader):
    pass

def tagged(loader, suffix, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node, deep=True)
    else:
        value = loader.construct_mapping(node, deep=True)
    key = 'Ref' if suffix == 'Ref' else ('Condition' if suffix == 'Condition' else 'Fn::' + suffix)
    if suffix == 'GetAtt' and isinstance(value, str):
        value = value.split('.', 1)
    return {key: value}

Loader.add_multi_constructor('!', tagged)
print(json.dumps(yaml.load(open(sys.argv[1]), Loader=Loader)))
`;

function readTemplate() {
    const result = spawnSync(lint.interpreter, ['-c', READ_YAML, TEMPLATE], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

describe('deploy/aws/ecs-express.yaml', { skip: missing ?? false }, () => {
    it('passes cfn-lint', () => {
        const result = spawnSync(lint.bin, [TEMPLATE], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stdout + result.stderr);
    });

    it('passes the public-content check', { skip: CONTENT_CHECK ? false : 'the content checker was not found' }, () => {
        const result = spawnSync(process.execPath, [CONTENT_CHECK, '--patterns-only', TEMPLATE], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stdout + result.stderr);
    });

    it('describes the table the servers expect', { skip: lint?.interpreter ? false : 'cfn-lint interpreter not found' }, () => {
        const resources = readTemplate().Resources;
        const tables = Object.entries(resources).filter(([, r]) => r.Type === 'AWS::DynamoDB::Table');
        assert.equal(tables.length, 2, 'one retained table and one disposable table');
        for (const [name, table] of tables) {
            const p = table.Properties;
            assert.equal(p.BillingMode, 'PAY_PER_REQUEST', name);
            assert.deepEqual(p.KeySchema.map((k) => ({ name: k.AttributeName, type: k.KeyType })), TABLE_SPEC.keys, name);
            assert.deepEqual(
                p.GlobalSecondaryIndexes.map((g) => ({ name: g.IndexName, hash: g.KeySchema[0].AttributeName, range: g.KeySchema[1].AttributeName })),
                TABLE_SPEC.indexes,
                name
            );
            for (const g of p.GlobalSecondaryIndexes) assert.equal(g.Projection.ProjectionType, 'ALL', name);
            assert.deepEqual(p.TimeToLiveSpecification, { AttributeName: TABLE_SPEC.ttlAttribute, Enabled: true }, name);
            const defined = p.AttributeDefinitions.map((a) => a.AttributeName).sort();
            const used = [...TABLE_SPEC.keys.map((k) => k.name), ...TABLE_SPEC.indexes.flatMap((i) => [i.hash, i.range])].sort();
            assert.deepEqual(defined, used, name);
            for (const a of p.AttributeDefinitions) assert.equal(a.AttributeType, 'S', name);
        }
        const policies = [];
        for (const r of Object.values(resources)) {
            if (r.Type !== 'AWS::IAM::Role') continue;
            for (const entry of r.Properties.Policies || []) {
                const choices = entry['Fn::If'] ? entry['Fn::If'].slice(1) : [entry];
                for (const policy of choices) if (policy.PolicyDocument) policies.push(...policy.PolicyDocument.Statement);
            }
        }
        const actions = policies.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
        for (const needed of ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchGetItem', 'dynamodb:BatchWriteItem', 'dynamodb:Query']) {
            assert.ok(actions.includes(needed), 'the task role needs ' + needed);
        }
    });

    it('can be deployed twice into one account: no fixed names, no exports, everything tagged', { skip: lint?.interpreter ? false : 'cfn-lint interpreter not found' }, () => {
        const template = readTemplate();
        const NAME_PROPERTIES = ['TableName', 'QueueName', 'SecretName', 'Name', 'LogGroupName', 'RoleName', 'GroupName', 'ServiceName', 'ServerlessCacheName', 'ManagedPolicyName'];
        const TAGGABLE = new Set(['AWS::DynamoDB::Table', 'AWS::SQS::Queue', 'AWS::SecretsManager::Secret', 'AWS::Logs::LogGroup',
            'AWS::EC2::SecurityGroup', 'AWS::ElastiCache::ServerlessCache', 'AWS::IAM::Role', 'AWS::ECS::ExpressGatewayService']);
        for (const [name, resource] of Object.entries(template.Resources)) {
            const props = resource.Properties || {};
            for (const key of NAME_PROPERTIES) {
                if (key === 'ServerlessCacheName') {
                    assert.ok(resource.Type !== 'AWS::ElastiCache::ServerlessCache' || JSON.stringify(props[key] || '').includes('AWS::StackId'), name + ' names the cache from the stack id so two stacks do not collide');
                } else {
                    assert.equal(props[key], undefined, name + ' must not fix ' + key + ': a second stack would fail');
                }
            }
            if (TAGGABLE.has(resource.Type)) {
                const tagKeys = (props.Tags || []).map((t) => t.Key);
                assert.ok(tagKeys.includes('starter-crm:site-id'), name + ' is missing the starter-crm:site-id tag');
                assert.ok(tagKeys.includes('starter-crm:stack'), name + ' is missing the starter-crm:stack tag');
            }
        }
        for (const [name, output] of Object.entries(template.Outputs)) {
            assert.equal(output.Export, undefined, 'output ' + name + ' must not be exported: exports are unique per region');
        }
    });
});
