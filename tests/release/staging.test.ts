import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { runStagingRehearsal } from '../../tools/release/staging-rehearsal';

const enabled = process.env.STAGING_REHEARSAL === '1' && Boolean(process.env.TEST_DATABASE_URL && process.env.STAGING_CANDIDATE_ARCHIVE && process.env.STAGING_PREVIOUS_ARCHIVE);
it.skipIf(!enabled)('deploys distinct immutable artifacts with DML-only serving, restores PostgreSQL and switches traffic back', async () => {
  const path = '.tmp/staging/release-31.json';
  await runStagingRehearsal([process.env.STAGING_CANDIDATE_ARCHIVE!, process.env.STAGING_PREVIOUS_ARCHIVE!, path]);
  const report = JSON.parse(await readFile(path, 'utf8'));
  expect(report.outcome).toBe('passed');
  expect(report.observations.map((value: { phase: string }) => value.phase)).toEqual(['previous-before-deployment', 'candidate', 'rollback']);
  expect(report.artifacts.candidate.commit).not.toBe(report.artifacts.previous.commit);
  expect(report.databaseRestore.equalityPassed).toBe(true);
  expect(report.cleanup).toEqual({ ownedServersStopped: true, disposableDatabasesDropped: 2, servingRoleDropped: true });
}, 180_000);
