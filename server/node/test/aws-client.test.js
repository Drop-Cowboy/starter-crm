import { describe, expect, it } from 'vitest';
import { clientConfig } from '../src/aws.js';

describe('clientConfig', () => {
    it('passes on credentials from the merged environment, because the SDK reads only the process environment', () => {
        const config = clientConfig({ AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: ' key-1 ', AWS_SECRET_ACCESS_KEY: 'secret-1', AWS_SESSION_TOKEN: 'token-1' }, 'SQS');
        expect(config.credentials).toEqual({ accessKeyId: 'key-1', secretAccessKey: 'secret-1', sessionToken: 'token-1' });
        expect(config.region).toBe('us-east-1');
    });

    it('leaves credentials to the SDK (the task role) when the environment has none or only half', () => {
        expect(clientConfig({ AWS_REGION: 'us-east-1' }, 'SQS').credentials).toBeUndefined();
        expect(clientConfig({ AWS_ACCESS_KEY_ID: 'key-1' }, 'SQS').credentials).toBeUndefined();
        expect(clientConfig({ AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' }, 'SQS').credentials).toBeUndefined();
    });

    it('omits an empty session token', () => {
        const config = clientConfig({ AWS_ACCESS_KEY_ID: 'key-1', AWS_SECRET_ACCESS_KEY: 'secret-1', AWS_SESSION_TOKEN: ' ' }, 'SSM');
        expect(config.credentials).toEqual({ accessKeyId: 'key-1', secretAccessKey: 'secret-1' });
    });
});
