import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4310',
    viewport: { width: 1600, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:4310/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { PORT: '4310', GITHUB_TOKEN: '', AI_ENABLED: 'false', TYPESAFE_API_KEY: '', JEV_MODEL: '', OPENAI_API_KEY: '', OPENAI_MODEL: '', DATABASE_URL: '', GROUPING_STORAGE_PATH: '' },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 }, ...(process.env.PLAYWRIGHT_CHROME ? { channel: 'chrome' } : {}) } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1600, height: 1000 } } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1600, height: 1000 } } },
  ],
});
