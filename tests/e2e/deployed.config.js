import { defineConfig, devices } from '@playwright/test';

// The browser half of `npm run test:deployed`: one spec against a server that is
// already running somewhere. It starts nothing and downloads nothing, so it
// has no global setup, and it lives outside ./specs so `npm test` never runs it.
// STARTER_CRM_DEPLOYED_URL says where; scripts/test-deployed.mjs sets it.
export default defineConfig({
    testDir: './deployed',
    outputDir: './test-results/deployed',
    fullyParallel: false,
    workers: 1,
    retries: 1,
    timeout: 60000,
    expect: { timeout: 15000 },
    reporter: [['list']],
    use: {
        ...devices['Desktop Chrome'],
        baseURL: process.env.STARTER_CRM_DEPLOYED_URL,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: process.env.PLAYWRIGHT_VIDEO === 'on' ? 'on' : 'off'
    },
    projects: [
        { name: 'vanilla', use: { entry: '/' } },
        { name: 'react', use: { entry: '/react/' } }
    ]
});
