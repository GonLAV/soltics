import { defineConfig, devices } from '@playwright/test';

// Part 3 (code review) runs as its own suite, deliberately separate from the
// delivery suite in ./tests — submitted.spec.ts is EXPECTED TO FAIL, and a
// failing spec must never be mixed into the suite that gates a release.
//
// It always targets an already-running instance (BASE_URL, default :3000) and
// starts no server of its own, so the failures are demonstrated against the
// same app on screen.
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  // Each test drives its own browser context against its own user, so there
  // is nothing to serialise. Running them in parallel is what keeps this
  // demonstrable live rather than a minute of dead air.
  testDir: './tests-code-review',
  fullyParallel: true,
  workers: 4,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
