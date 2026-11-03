import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/** Dedicated production sample: one browser/worker and synthetic data only. */
const port = process.env.GRAPH_BENCHMARK_PORT || '4427';
export default defineConfig({
  ...base,
  testMatch: /graph-(performance|capacity)\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: { ...base.use, baseURL: `http://127.0.0.1:${port}` },
  projects: base.projects?.filter(project => project.name === 'chromium'),
  webServer: {
    command: 'pnpm start',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: process.env.GRAPH_BENCHMARK_REUSE === 'true',
    timeout: 60_000,
    env: { PORT: port, GITHUB_TOKEN: '', AI_ENABLED: 'false', TYPESAFE_API_KEY: '', JEV_MODEL: '', OPENAI_API_KEY: '', OPENAI_MODEL: '', DATABASE_URL: '', GROUPING_STORAGE_PATH: '' },
  },
});
