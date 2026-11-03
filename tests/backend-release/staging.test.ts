import { expect, it } from 'vitest';
import { runStagingChecks } from './staging';

it.skipIf(process.env.STAGING_REHEARSAL !== '1' || !process.env.TEST_DATABASE_URL)('staging production HTTP + PostgreSQL resource and isolation gate', async () => {
  expect(await runStagingChecks()).toMatchObject({ status: 'passed', checks: 7 });
}, 90_000);
