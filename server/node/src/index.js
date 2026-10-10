import path from 'node:path';
import dotenv from 'dotenv';
import { createApp } from './app.js';
import { loadConfig, starterRoot } from './config.js';
import { isLoopbackAddress } from './dev-session.js';
import { createLogger } from './log.js';

// Variables already in the environment win over .env.
const root = starterRoot(process.env);
dotenv.config({ path: path.join(root, '.env'), quiet: true });

const { config, problems } = loadConfig(process.env, root);
if (problems.length > 0) {
    console.error('The Starter CRM server cannot start:\n  - ' + problems.join('\n  - ') +
        '\nCopy .env.example to .env at the starter root and fill it in.');
    process.exit(1);
}

const log = createLogger(config);
// Express 5 also calls this with the error when listening fails; the 'error'
// handler below reports it.
const server = createApp(config, { log }).listen(config.port, config.host, (err) => {
    if (err) return;
    const address = server.address();
    const host = address.family === 'IPv6' ? '[' + address.address + ']' : address.address;
    log.info('Starter CRM server (DC_AUTH_MODE=' + config.mode + ') on http://' + host + ':' + address.port);
    if (!isLoopbackAddress(address.address) && address.address !== 'localhost') {
        log.warn('HOST is not loopback: other machines on your network can reach this server.');
    }
    if (config.webhookSecrets.length === 0) {
        log.warn('DROPCOWBOY_WEBHOOK_SECRET is not set, so webhooks will be refused with 503.');
    }
});

server.on('error', (err) => {
    log.error('Could not listen on ' + config.host + ':' + config.port + ':', err.message);
    process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        server.close(() => process.exit(0));
        // Open event streams would otherwise keep the server alive.
        server.closeAllConnections();
    });
}
