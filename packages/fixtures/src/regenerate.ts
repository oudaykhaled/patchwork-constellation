/** Run with pnpm exec tsx packages/fixtures/src/regenerate.ts <empty-output-directory>. */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApiScenarios, API_FIXTURE_PROVENANCE, API_GOLDEN } from './api-fixtures';
import { createGitHistoryFixture } from './git-history';
import { createDemoSnapshot, createScaleFixture } from './index';

const destination = process.argv[2];
if (!destination) throw new Error('Supply an empty output directory; existing files are never removed');
const output = resolve(destination);
mkdirSync(output, { recursive: true });
if (readdirSync(output).length) throw new Error('Output directory must be empty');
const history = createGitHistoryFixture(resolve(output, 'history'));
const documents = {
  'design.json': createDemoSnapshot(),
  'scale-2000-8000-seed42.json': createScaleFixture(2_000, 8_000, 42),
  'scale-10000-40000-seed42.json': createScaleFixture(10_000, 40_000, 42),
  'api-scenarios.json': { provenance: API_FIXTURE_PROVENANCE, golden: API_GOLDEN, scenarios: createApiScenarios() },
  'history-golden.json': { refs: history.refs, golden: history.golden },
};
const digests: Record<string, string> = {};
for (const [name, document] of Object.entries(documents)) {
  const bytes = JSON.stringify(document, null, 2) + '\n';
  digests[name] = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(resolve(output, name), bytes, 'utf8');
}
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify({ version: 1, seed: 42, sha256: digests }, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ output, files: Object.keys(documents), sha256: digests }, null, 2));
