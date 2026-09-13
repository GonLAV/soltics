import { defineConfig, devices } from '@playwright/test';

// Point the suite at another environment with BASE_URL. When it is set the
// local mock is not started and only the portable contract spec runs — the
// mock-only suites assume this demo's REST shape and page instrumentation.
const BASE_URL = process.env.BASE_URL;
const IS_REMOTE = Boolean(BASE_URL);
const LOCAL_PORT = process.env.LOCAL_PORT ?? '4173';
const LOCAL_BASE_URL = `http://localhost:${LOCAL_PORT}`;

const MOCK_ONLY = ['**/campaign-engine.spec.ts', '**/demo-instrumentation.spec.ts'];

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: IS_REMOTE ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL ?? LOCAL_BASE_URL,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: IS_REMOTE ? MOCK_ONLY : [],
    },
  ],

  // No local server when targeting a real environment.
  webServer: IS_REMOTE
    ? undefined
    : {
        command: `node server.js`,
        url: `${LOCAL_BASE_URL}/api/v1/health`,
        env: { PORT: LOCAL_PORT },
        // Locally, reuse a server already started with `npm start` so the tests
        // and the browser you are clicking through hit the same backend state.
        reuseExistingServer: !process.env.CI,
        stdout: 'ignore',
        stderr: 'pipe',
      },
});
