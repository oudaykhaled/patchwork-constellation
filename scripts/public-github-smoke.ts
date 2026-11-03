import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSelectionFootprint, validateGraphSnapshot, type GraphSnapshot } from '../packages/contracts/src/index';
import { diffLink } from '../apps/web/src/file-evidence';

// An explicit, opt-in network smoke. No transport, analyzer, worker or BFF route
// is replaced. The fixed public fixture keeps inventory and request work small.
if (!process.argv.includes('--live')) throw new Error('Use --live to request the public GitHub smoke. This command accesses GitHub.');
const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
if (existsSync('.env')) throw new Error('Run this smoke in an isolated checkout without a .env file.');
for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_APP_ID', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET', 'APP_ORIGIN', 'DATABASE_URL', 'GROUPING_STORAGE_PATH', 'TYPESAFE_API_KEY', 'JEV_MODEL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'AI_EVALUATION_MANIFEST', 'AI_EXCLUDED_PATHS']) process.env[key] = '';
process.env.NODE_ENV = 'test';
process.env.AI_ENABLED = 'false';
process.env.OPS_METRICS_ENABLED = 'true';
process.env.API_REQUESTS_PER_MINUTE = '240';

const repository = 'octocat/Hello-World';
const contextSha = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';
const sourceShas = [contextSha, '762941318ee16e59dabbacb1b4049eec22f0d303'];
const output = resolve(root, '.tmp/public-github-smoke.json');
const started = performance.now();
const deadline = AbortSignal.timeout(90_000);
let verificationRequests = 0;
let server: Awaited<ReturnType<typeof import('../apps/web/server')['createApplicationServer']>> | undefined;
const checks: { id: string; status: 'passed'; evidence: unknown }[] = [];

async function boundedResponse(response: Response, limit = 2_000_000) {
  assert(response.ok, `HTTP request failed (${response.status}).`);
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > limit) { await reader.cancel(); throw new Error('Smoke response exceeded its byte budget.'); }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function github(path: string) {
  assert(++verificationRequests <= 8, 'Independent verification request budget exceeded.');
  assert(path.startsWith(`/repos/${repository}/`));
  const response = await fetch(`https://api.github.com${path}`, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Patchwork-Public-Smoke' }, signal: deadline, redirect: 'error' });
  return JSON.parse(await boundedResponse(response));
}

try {
  // Verify the fixture before asking the application to analyze it. These
  // requests are independent ground truth, not a substituted product gateway.
  const tree = await github(`/repos/${repository}/git/trees/${contextSha}?recursive=1`);
  assert.equal(tree.truncated, false);
  const expectedPaths = tree.tree.filter((entry: { type: string }) => entry.type === 'blob' || entry.type === 'commit').map((entry: { path: string }) => entry.path).sort();
  assert.deepEqual(expectedPaths, ['README']);
  checks.push({ id: 'public-pinned-ground-truth', status: 'passed', evidence: { repository, contextSha, paths: expectedPaths } });

  const { createApplicationServer } = await import('../apps/web/server');
  server = await createApplicationServer({ production: true });
  await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
  const address = server.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const request = async (path: string, payload?: unknown) => {
    assert(path.startsWith('/api/'));
    const response = await fetch(origin + path, { ...(payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(payload) }), signal: deadline, redirect: 'error' });
    return JSON.parse(await boundedResponse(response));
  };
  const config = await request('/api/config');
  assert.equal(config.mode, 'local-public'); assert.equal(config.github.configuredToken, false); assert.equal(config.github.appConfigured, false); assert.equal(config.ai.enabled, false); assert.equal(config.ai.configured, false);
  checks.push({ id: 'credential-free-public-mode', status: 'passed', evidence: { mode: config.mode, configuredGithubToken: false, appConfigured: false, externalAiEnabled: false, storage: config.storage } });

  const submitted = await request('/api/analyze', { repository, contextRef: contextSha, mode: 'commit' });
  assert.match(submitted.jobId, /^[a-f0-9]{64}$/);
  let snapshot: GraphSnapshot | undefined;
  for (let poll = 0; poll < 120; poll++) {
    const job = await request(`/api/jobs/${submitted.jobId}?repository=${encodeURIComponent(repository)}`);
    assert(!['failed', 'cancelled'].includes(job.status), `Analysis ended with ${job.status}.`);
    if (job.snapshot) { snapshot = validateGraphSnapshot(job.snapshot); break; }
    await delay(250, undefined, { signal: deadline });
  }
  assert(snapshot, 'Analysis did not produce a snapshot inside the polling budget.');
  assert.equal(snapshot.contextSha, contextSha); assert.equal(snapshot.mode, 'github');
  assert.deepEqual(snapshot.nodes.map(node => node.path).sort(), expectedPaths);
  assert.equal(snapshot.edges.length, 0);
  assert.equal(snapshot.nodes[0].importCoverage, 'unsupported');
  assert(snapshot.nodes[0].importReasons?.length, 'README parser limitations must be explicit.');
  checks.push({ id: 'real-bff-and-worker-analysis', status: 'passed', evidence: { files: snapshot.nodes.length, edges: snapshot.edges.length, groups: snapshot.groups.length, coverage: snapshot.coverage, perFileImportCoverage: snapshot.nodes[0].importCoverage, perFileImportReasons: snapshot.nodes[0].importReasons } });

  const discovered = await request(`/api/sources?snapshotId=${encodeURIComponent(snapshot.id)}&kind=commit&repository=${encodeURIComponent(repository)}`);
  const ids = sourceShas.map(sha => `commit:${sha}`);
  assert(ids.every(id => discovered.sources.some((source: { id: string }) => source.id === id)));
  snapshot = validateGraphSnapshot(await request('/api/sources', { snapshotId: snapshot.id, kind: 'commit', ids }));
  const sources = ids.map(id => snapshot!.sources.find(source => source.id === id)!);
  const groundTruth = [];
  for (const source of sources) {
    assert(source.loaded); assert.equal(source.coverage?.status, 'complete'); assert.equal(source.fileEvidence, 'github-api');
    const actual = await github(`/repos/${repository}/compare/${source.baseSha}...${source.headSha}?per_page=1`);
    const paths = actual.files.map((file: { filename: string }) => file.filename).sort();
    assert.deepEqual(source.files.map(file => file.path).sort(), paths);
    assert.deepEqual(paths, ['README']);
    groundTruth.push({ id: source.id, baseSha: source.baseSha, headSha: source.headSha, comparisonKind: source.comparisonKind, files: paths, coverage: source.coverage, fileEvidence: source.fileEvidence });
  }
  const footprint = createSelectionFootprint(snapshot, ids);
  assert.equal(footprint.counts.changedFiles, 1); assert.equal(footprint.counts.overlappingFiles, 1);
  checks.push({ id: 'live-multi-commit-footprint', status: 'passed', evidence: { sources: groundTruth, counts: footprint.counts } });

  const file = snapshot.nodes.find(node => node.path === 'README')!;
  const detail = await request(`/api/files/${encodeURIComponent(snapshot.id)}/${encodeURIComponent(file.id)}?repository=${encodeURIComponent(repository)}`);
  assert.equal(detail.file.path, 'README'); assert.equal(detail.sources.length, 2);
  const destination = await diffLink(snapshot, sources[0], sources[0].files[0]);
  assert(destination); assert.equal(new URL(destination).origin, 'https://github.com');
  const diffPage = await fetch(destination, { signal: deadline, redirect: 'error' });
  const diffHtml = await boundedResponse(diffPage);
  const expectedAnchor = `#diff-${createHash('sha256').update(detail.file.path).digest('hex')}`;
  assert.equal(new URL(destination).hash, expectedAnchor);
  // GitHub's initial comparison HTML can lazy-load the entire files pane. A
  // 200 shell and a generated fragment cannot prove rendered anchor navigation.
  // Verify the real pinned diff content independently and preserve that limit.
  const plainDiffUrl = new URL(destination); plainDiffUrl.hash = ''; plainDiffUrl.pathname += '.diff';
  const plainDiff = await fetch(plainDiffUrl, { signal: deadline, redirect: 'error' });
  const diffText = await boundedResponse(plainDiff);
  assert.match(diffText, /^diff --git a\/README b\/README\r?$/m);
  checks.push({ id: 'genuine-file-detail-and-diff', status: 'passed', evidence: { path: detail.file.path, sourceCount: detail.sources.length, destination, destinationStatus: diffPage.status, exactFileAnchorPresentInInitialHtml: diffHtml.includes(expectedAnchor.slice(1)), browserFragmentNavigationVerified: false, pinnedDiffTextStatus: plainDiff.status, pinnedDiffHeader: 'diff --git a/README b/README', pinnedDiffTextSha256: createHash('sha256').update(diffText).digest('hex') } });
  const metrics = await request('/api/metrics');
  assert(metrics.github.requests > 0 && metrics.github.requests <= 40); assert.equal(metrics.provider.requests, 0);
  checks.push({ id: 'observed-real-network-budget', status: 'passed', evidence: { productGithub: metrics.github, independentVerificationRequests: verificationRequests, githubComparisonAndDiffRequests: 2, providerRequests: metrics.provider.requests } });
  const report = { schemaVersion: '1', issue: 18, status: 'passed', recordedAt: new Date().toISOString(), applicationCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), runnerSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'), node: process.version, platform: `${process.platform}/${process.arch}`, durationMs: Math.round(performance.now() - started), sampleKind: 'live-anonymous-public-GitHub-through-product-BFF', checks, limits: ['One fixed public repository and two immutable commits; no credentialed/private GitHub App login, installation or revocation is established.', 'Loopback BFF with actual worker threads and live GitHub HTTP; no browser interaction, staging deployment or production traffic is established.', 'README-only inventory correctly reports unsupported import analysis; zero edges is not an analysis-capacity claim.', 'GitHub comparison shell and actual pinned diff content verified; rendered per-file fragment navigation is not established by an HTML fetch.', 'No accessibility review, intelligence enablement or beta approval is implied.'] };
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, output: '.tmp/public-github-smoke.json', checks: checks.length, files: snapshot.nodes.length, changed: footprint.counts.changedFiles, overlap: footprint.counts.overlappingFiles, productGithubRequests: metrics.github.requests, providerRequests: 0 }));
} finally {
  await server?.analysisJobs.close();
  if (server?.listening) { server.closeAllConnections(); await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done())); }
}
