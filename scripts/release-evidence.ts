import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export type EvidenceStatus = 'passed' | 'partial' | 'failed';
export type EvidenceCheck = { id: string; status: EvidenceStatus; evidence: string };
export type DependencyEvidence = { schemaVersion: '1'; status: EvidenceStatus; commit?: string; checks: EvidenceCheck[] };
export type SoakEvidence = {
  schemaVersion: '1'; files: number; edges: number; seed: number; appCommit: string; build: string;
  conditions: { concurrentActivity: string; network: string };
  coldNavigationToPaintMs: number; warmNavigationToPaintMs: number;
  selection: { samples: number; durationMs: number; p95Ms: number };
  hover: { samples: number; p95Ms: number };
  retainedBefore: { heapUsedBytes: number; nodes: number };
  retainedAfter: { heapUsedBytes: number; nodes: number };
  resourcesBefore: { workersCreated: number; workersLive: number; globalListeners: number };
  resourcesAfter: { workersCreated: number; workersLive: number; globalListeners: number };
};

const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{40,64}$/i.test(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const envelope = (value: unknown): value is DependencyEvidence => {
  if (!value || typeof value !== 'object') return false;
  const item = value as DependencyEvidence;
  return item.schemaVersion === '1' && ['passed', 'partial', 'failed'].includes(item.status) && Array.isArray(item.checks) && item.checks.length > 0 && item.checks.every(check => check && typeof check.id === 'string' && ['passed', 'partial', 'failed'].includes(check.status) && typeof check.evidence === 'string');
};

type AuthenticatedViewEvidence = {
  schemaVersion: '1'; status: EvidenceStatus; commit: string; sampleKind: 'controlled-authenticated-BFF'; files: number; edges: number; seed: number; sampleCount: number; p95Ms: number;
  samples: { responseEndMs: number; usefulPixelsMs: number; responseToUsefulMs: number; workerCount: number; warm: boolean; payloadBytes: number }[];
  conditions: { build: string };
  controls: { noSession: string; tamperedSession: string; missingCsrf: string; removedRepository: string; unauthorizedAnalysisCalls: number; analysisCalls: number; liveDiscoveryCalls: number; externalRequests: number };
};
export function validateAuthenticatedView(value: unknown): value is AuthenticatedViewEvidence {
  if (!value || typeof value !== 'object') return false;
  const item = value as AuthenticatedViewEvidence;
  if (item.schemaVersion !== '1' || item.sampleKind !== 'controlled-authenticated-BFF' || item.files !== 2_000 || item.edges !== 8_000 || item.seed !== 42 || !['passed', 'partial', 'failed'].includes(item.status) || !sha(item.commit) || item.conditions?.build !== 'production' || !Number.isInteger(item.sampleCount) || item.sampleCount < 20 || !finite(item.p95Ms) || item.p95Ms <= 0 || !Array.isArray(item.samples) || item.samples.filter(sample => sample.warm).length !== item.sampleCount) return false;
  const controls = item.controls;
  if (!controls || controls.noSession !== '401' || controls.tamperedSession !== '401' || controls.missingCsrf !== '403' || controls.removedRepository !== '403' || controls.unauthorizedAnalysisCalls !== 0 || controls.analysisCalls !== 1 || controls.liveDiscoveryCalls <= item.sampleCount || controls.externalRequests !== 0) return false;
  if (!item.samples.every(sample => typeof sample.warm === 'boolean' && [sample.responseEndMs, sample.usefulPixelsMs, sample.responseToUsefulMs, sample.workerCount, sample.payloadBytes].every(finite) && sample.responseEndMs > 0 && sample.usefulPixelsMs > sample.responseEndMs && Math.abs(sample.responseToUsefulMs - (sample.usefulPixelsMs - sample.responseEndMs)) < .01 && Number.isInteger(sample.workerCount) && sample.workerCount > 0 && Number.isInteger(sample.payloadBytes) && sample.payloadBytes > 20_000)) return false;
  const sorted = item.samples.filter(sample => sample.warm).map(sample => sample.responseToUsefulMs).sort((a, b) => a - b);
  return Math.abs(item.p95Ms - sorted[Math.ceil(sorted.length * .95) - 1]) < .01;
}

export function validateSoak(value: unknown): value is SoakEvidence {
  if (!value || typeof value !== 'object') return false;
  const item = value as SoakEvidence;
  const numbers = [item.files, item.edges, item.seed, item.coldNavigationToPaintMs, item.warmNavigationToPaintMs, item.selection?.samples, item.selection?.durationMs, item.selection?.p95Ms, item.hover?.samples, item.hover?.p95Ms, item.retainedBefore?.heapUsedBytes, item.retainedAfter?.heapUsedBytes, item.retainedBefore?.nodes, item.retainedAfter?.nodes, item.resourcesBefore?.workersCreated, item.resourcesAfter?.workersCreated, item.resourcesBefore?.workersLive, item.resourcesAfter?.workersLive, item.resourcesBefore?.globalListeners, item.resourcesAfter?.globalListeners];
  return item.schemaVersion === '1' && numbers.every(finite) && Number.isInteger(item.files) && item.files > 0 && Number.isInteger(item.edges) && Number.isInteger(item.selection?.samples) && item.selection.samples > 0 && item.selection.durationMs > 0 && item.selection.p95Ms > 0 && Number.isInteger(item.hover?.samples) && item.hover.samples > 0 && item.hover.p95Ms > 0 && typeof item.appCommit === 'string' && typeof item.build === 'string' && typeof item.conditions?.concurrentActivity === 'string' && typeof item.conditions?.network === 'string';
}

/** Aggregate measured artifacts. A successful script invocation never means the
 * release gate passed: callers must inspect status or use --require-release. */
export function buildReleaseEvidence(input: { soak: unknown[]; renderer?: unknown; backend?: unknown; referenceRunner?: string; analysisPhaseEvidence?: string; authenticatedView?: unknown; authenticatedViewReference?: string }) {
  const checks: EvidenceCheck[] = [];
  const valid = input.soak.filter(validateSoak);
  const add = (id: string, status: EvidenceStatus, evidence: string) => checks.push({ id, status, evidence });
  if (valid.length !== input.soak.length) add('artifact-shape', 'failed', 'One or more supplied soak artifacts fail the versioned finite-number schema.');
  const fixtures = [[212, 235], [2_000, 8_000], [10_000, 40_000]];
  for (const [files, edges] of fixtures) {
    const matches = valid.filter(sample => sample.files === files && sample.edges === edges && sample.seed === 42);
    if (matches.length !== 1) { add(`fixture-${files}`, 'partial', `Expected one seed-42 ${files}/${edges} artifact; received ${matches.length}.`); continue; }
    const item = matches[0];
    const bounds = Math.max(8_000_000, files * 1_600);
    const heapDelta = item.retainedAfter.heapUsedBytes - item.retainedBefore.heapUsedBytes;
    const resourcesOkay = item.resourcesAfter.workersCreated === item.resourcesBefore.workersCreated && item.resourcesAfter.workersLive === item.resourcesBefore.workersLive && item.resourcesAfter.globalListeners <= item.resourcesBefore.globalListeners && heapDelta < bounds && item.retainedAfter.nodes - item.retainedBefore.nodes < 1_000;
    add(`retention-${files}`, resourcesOkay ? 'passed' : 'failed', `${item.selection.samples} review toggles; retained GC heap delta ${heapDelta} B; worker/handler/DOM counts are separate measurements. This detects gross growth, not absence of every leak.`);
    add(`soak-${files}`, item.selection.samples >= 1_000 ? 'passed' : 'partial', `${item.selection.samples} toggles over ${(item.selection.durationMs / 1_000).toFixed(2)} s; longer wall-clock staging sessions remain separate evidence.`);
    if (files === 2_000) {
      add('selection-budget', item.selection.p95Ms <= 250 ? 'passed' : 'failed', `Warm event-to-feedback p95 ${item.selection.p95Ms.toFixed(2)} ms; target ≤250 ms.`);
      add('hover-budget', item.hover.p95Ms < 100 ? 'passed' : 'failed', `Pointer-event-to-tooltip p95 ${item.hover.p95Ms.toFixed(2)} ms; target <100 ms.`);
      add('warm-navigation-sample', item.warmNavigationToPaintMs <= 2_000 ? 'passed' : 'failed', `Warm navigation to painted file circles ${item.warmNavigationToPaintMs.toFixed(2)} ms. Includes modules/network; does not substitute for authenticated-response-to-view timing.`);
    }
  }
  const commits = new Set(valid.map(item => item.appCommit));
  add('same-production-build', valid.length === 3 && commits.size === 1 && sha(valid[0]?.appCommit) && valid.every(item => item.build === 'production') ? 'passed' : 'partial', `Artifacts must share one recorded immutable commit and production build; observed ${[...commits].join(', ') || 'none'}.`);
  for (const [id, artifact] of [['GRAPH-04', input.renderer], ['DATA-09', input.backend]] as const) {
    if (!envelope(artifact)) { add(id, 'partial', 'Versioned dependency report with explicit check evidence is missing or invalid.'); continue; }
    const sameCommit = commits.size === 1 && artifact.commit === [...commits][0];
    const status = artifact.status === 'failed' || artifact.checks.some(check => check.status === 'failed') ? 'failed' : artifact.status === 'passed' && artifact.checks.every(check => check.status === 'passed') && sameCommit ? 'passed' : 'partial';
    add(id, status, `${artifact.checks.length} linked checks, status ${artifact.status}, same measured commit ${sameCommit}. Preserve its detailed renderer/backend report.`);
  }
  add('reference-runner', input.referenceRunner ? 'passed' : 'partial', input.referenceRunner || 'No stable reference-runner assertion supplied; concurrent agent activity cannot establish a release budget.');
  add('analysis-phases', input.analysisPhaseEvidence ? 'passed' : 'partial', input.analysisPhaseEvidence || 'No actual phase timing evidence supplied. Mocked worker delay is not repository analysis latency.');
  if (input.authenticatedView === undefined) add('authenticated-useful-view', 'partial', 'No measured authenticated BFF response-to-useful-view artifact supplied. Synthetic navigation is a different measure.');
  else if (!validateAuthenticatedView(input.authenticatedView)) add('authenticated-useful-view', 'failed', 'Authenticated artifact failed measured-sample, real-worker, finite-timing or denied-session/CSRF/repository control validation.');
  else {
    const artifact = input.authenticatedView;
    const sameCommit = commits.size === 1 && artifact.commit === [...commits][0];
    add('authenticated-useful-view', artifact.status === 'failed' || artifact.p95Ms > 2_000 ? 'failed' : sameCommit && artifact.status === 'passed' ? 'passed' : 'partial', `${artifact.sampleCount} warm controlled-identity BFF samples; response-body-arrival to worker-ready file pixels p95 ${artifact.p95Ms.toFixed(2)} ms; same measured commit ${sameCommit}. ${input.authenticatedViewReference || ''} No live App registration or WAN claim.`);
  }
  const status: EvidenceStatus = checks.some(check => check.status === 'failed') ? 'failed' : checks.every(check => check.status === 'passed') ? 'passed' : 'partial';
  return { schemaVersion: '1' as const, generatedAt: new Date().toISOString(), status, releaseReady: status === 'passed', commit: commits.size === 1 ? [...commits][0] : undefined, checks, limitations: ['This report aggregates evidence supplied by the caller; it does not certify independent human review or staging conditions.', 'API timeout, worker restart, GitHub retry and provider-outage outcomes come from linked backend suites; browser fixture timings do not establish those outcomes.', 'Do not enable intelligence or publish beta solely because bounded synthetic interaction budgets pass.'] };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const option = (name: string) => { const i = arguments_.indexOf(name); if (i >= 0 && arguments_[i + 1] && !arguments_[i + 1].startsWith('--')) return arguments_[i + 1]; return undefined; };
  const directory = resolve(option('--directory') || '.tmp/release-evidence');
  const readOptional = async (path?: string) => { if (!path) return undefined; return JSON.parse(await readFile(resolve(path), 'utf8')) as unknown; };
  const soak: unknown[] = [];
  for (const size of [212, 2_000, 10_000]) {
    try { soak.push(await readOptional(resolve(directory, `release-soak-${size}.json`))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const report = buildReleaseEvidence({ soak, renderer: await readOptional(option('--renderer')), backend: await readOptional(option('--backend')), referenceRunner: option('--reference-runner'), analysisPhaseEvidence: option('--analysis-phases'), authenticatedView: await readOptional(option('--authenticated-view')), authenticatedViewReference: option('--authenticated-view') });
  const output = resolve(option('--output') || resolve(directory, 'DEL-05.json'));
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, releaseReady: report.releaseReady, output, pending: report.checks.filter(check => check.status !== 'passed').map(check => check.id) }));
  if (report.status === 'failed' || (arguments_.includes('--require-release') && !report.releaseReady)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
