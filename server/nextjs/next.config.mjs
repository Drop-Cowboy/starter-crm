// The Starter CRM's Next.js variant. Where it sits: `next build` and `next start` read this file.
//
// The routes are a thin layer over the core in ../node, and the core reads migrations, schemas and the front-end
// files from disk, so it is loaded at run time from where it lives (see lib/core.js) and not bundled. Next's file
// tracing cannot see a file that is imported by a computed path, so `outputFileTracingIncludes` names what the
// deployed function needs: the core with its dependencies, the migrations and schemas, and both front-ends.
// What a customer changes: nothing.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

/** @type {import('next').NextConfig} */
const config = {
    // Trace from the starter root, so files outside this folder can be part of the deployed function.
    outputFileTracingRoot: root,
    outputFileTracingIncludes: {
        '/**': [
            '../node/src/**',
            '../node/package.json',
            '../node/node_modules/**',
            '../migrations/**',
            '../schemas/**',
            '../../shared/**',
            '../../vanilla/**',
            '../../react/dist/**',
            '../../*.js',
            '../../*.mjs'
        ]
    },
    // The core answers every path itself, including its own error pages, compression and headers.
    poweredByHeader: false,
    compress: false,
    skipTrailingSlashRedirect: true,
    // The core's modules and providers load from disk; nothing in this app needs the bundler to process them.
    serverExternalPackages: ['@vercel/queue', '@upstash/qstash', 'pg', 'ioredis', 'bullmq', 'dotenv', 'jose'],
    // The app has no pages, so there is nothing to type-check or lint at build time beyond the routes.
    typescript: { ignoreBuildErrors: true },
    reactStrictMode: true
};

export default config;
