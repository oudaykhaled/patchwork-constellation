import { defineConfig } from '@playwright/test';

// Each test worker owns its dependency-injected real BFF on an ephemeral port.
// No production fixture endpoint or shared development server is involved.
export default defineConfig({
  testDir: './tests/performance',
  testMatch: 'authenticated-view.spec.ts',
  outputDir: '.tmp/authenticated-view-test-results',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  use: { headless: true, viewport: { width: 1600, height: 1000 }, trace: 'off', screenshot: 'only-on-failure', video: 'off' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium', ...(process.env.PLAYWRIGHT_CHROME ? { channel: 'chrome' } : {}) } }],
});
