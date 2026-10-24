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
    // One set of specs serves both targets. `npm test` runs the fake target;
    // `npm run test:live` sets STARTER_CRM_LIVE=1 and skips what is tagged
    // @fake-only (specs that would rent a number, send to a phone or spend).
    grepInvert: process.env.STARTER_CRM_LIVE === '1' ? /@fake-only/ : /@live-only/,
    use: {
        ...devices['Desktop Chrome'],
        trace: process.env.STARTER_CRM_LIVE === '1' || process.env.PLAYWRIGHT_TRACE === 'on'
            ? 'on'
            : 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: process.env.STARTER_CRM_LIVE === '1' || process.env.PLAYWRIGHT_VIDEO === 'on'
            ? 'on'
            : 'off',
        // Live only: the sandbox call specs place real calls to 555 test
        // numbers, which need a microphone. Chrome's fake device supplies one
        // and grants it without a prompt. Launch options are per worker, so
        // they are set here rather than in the spec.
        ...(process.env.STARTER_CRM_LIVE === '1'
            ? { launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] } }
            : {})
    },
    projects: [
        { name: 'vanilla', use: { ui: 'vanilla' } },
        { name: 'react', use: { ui: 'react' } }
    ]
});
