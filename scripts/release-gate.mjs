import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function releaseGate(value, commit) {
  if (!value || value.schemaVersion !== '1' || value.commit !== commit || !/^[a-f0-9]{40}$/.test(commit) || value.license !== 'Apache-2.0' || value.stage !== 'production' || value.intelligence !== 'disabled') throw new Error('Production acceptance does not match this deterministic artifact');
  if (!value.hosting || typeof value.hosting !== 'string' || !value.reviewedBy || typeof value.reviewedBy !== 'string') throw new Error('Hosting and maintainer review are required');
  for (const name of ['browser', 'accessibility', 'performance', 'backend', 'security', 'deployment', 'databaseRestore', 'rollback']) {
    const evidence = value.evidence?.[name]; if (!evidence || evidence.status !== 'passed' || typeof evidence.reference !== 'string' || !evidence.reference.trim() || evidence.commit !== commit) throw new Error('Missing same-commit release evidence');
  }
  return { commit, stage: 'production', intelligence: 'disabled', hosting: value.hosting };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const value = JSON.parse(await readFile(process.argv[2] || '.release/acceptance.json', 'utf8')); console.log(JSON.stringify(releaseGate(value, process.argv[3] || ''), null, 2)); }
  catch { console.error('Production promotion blocked: reviewed, same-commit deployment, restore, rollback and quality evidence is required. Intelligence-enabled releases require a separate AI evaluation gate.'); process.exitCode = 1; }
}
