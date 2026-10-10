import { defineConfig, devices } from '@playwright/test';

// Two projects, one per front-end. The server under test comes from
// SERVER_CMD / SERVER_CWD (Node when unset); see support/app-server.js.
export default defineConfig({
    testDir: './specs',
    outputDir: './test-results',
    globalSetup: './support/global-setup.js',
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 2 : undefined,
    timeout: 30000,
    expect: { timeout: 7000 },
    reporter: process.env.CI
        ? [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]]
        : [['list']],
    use: {
        ...devices['Desktop Chrome'],
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    projects: [
        { name: 'vanilla', use: { ui: 'vanilla' } },
        { name: 'react', use: { ui: 'react' } }
    ]
});
