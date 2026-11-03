import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { extractReleaseArchive } from './release-artifact.mjs';

// This rehearses local deterministic artifacts only. It does not deploy or migrate a service.
function execute(binary, args, cwd, env) { return new Promise((resolvePromise, reject) => { const child = spawn(binary, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; child.stdout.on('data', data => { output = (output + data).slice(-2000); }); child.stderr.on('data', data => { output = (output + data).slice(-2000); }); child.once('error', reject); child.once('exit', code => code === 0 ? resolvePromise(output) : reject(new Error('Rehearsal child command failed; inspect local installation.'))); }); }
async function verifiedArchive(path) { const absolute = resolve(path); const bytes = await readFile(absolute); const checksum = (await readFile(`${absolute}.sha256`, 'utf8')).split(/\s+/)[0]; if (!/^[a-f0-9]{64}$/.test(checksum) || createHash('sha256').update(bytes).digest('hex') !== checksum) throw new Error('Archive digest mismatch'); return absolute; }
async function waitForHealth(url, child) { for (let attempt = 0; attempt < 80; attempt++) { if (child.exitCode !== null) throw new Error('Rehearsal server exited'); try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch { /* startup */ } await new Promise(resolvePromise => setTimeout(resolvePromise, 250)); } throw new Error('Rehearsal server startup timed out'); }
async function stop(child) { if (child.exitCode !== null) return; child.kill(); await new Promise(resolvePromise => { child.once('exit', resolvePromise); setTimeout(() => { child.kill('SIGKILL'); resolvePromise(); }, 4000).unref(); }); }
const current = process.argv[2], previous = process.argv[3];
if (!current || !previous) { console.error('Use pnpm release:rehearse <candidate.tar.gz> <previous.tar.gz>. Both checksums and complete manifests are required.'); process.exitCode = 1; }
else {
  let running;
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:TOKEN|SECRET|API_KEY|PASSWORD|DATABASE_URL|GROUPING_STORAGE|GITHUB_APP|AI_EVALUATION)/i.test(name)));
    Object.assign(env, { AI_ENABLED: 'false', DATABASE_URL: '', GROUPING_STORAGE_PATH: '', GITHUB_TOKEN: '', TYPESAFE_API_KEY: '', OPENAI_API_KEY: '', JEV_MODEL: '', OPENAI_MODEL: '', NODE_OPTIONS: '', OPS_METRICS_ENABLED: 'true' });
    const base = resolve('.cache'); await (await import('node:fs/promises')).mkdir(base, { recursive: true }); const directory = await mkdtemp(join(base, 'release-rehearsal-'));
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const install = async cwd => process.platform === 'win32' ? execute(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'pnpm install --offline --frozen-lockfile'], cwd, env) : execute(pnpm, ['install', '--offline', '--frozen-lockfile'], cwd, env);
    const results = [];
    for (const [stage, archivePath] of [['candidate', current], ['rollback', previous]]) {
      const archive = await verifiedArchive(archivePath); const cwd = join(directory, stage); const manifest = await extractReleaseArchive(await readFile(archive), cwd); await install(cwd);
      const port = stage === 'candidate' ? 4531 : 4532; running = spawn(process.execPath, [join(cwd, 'node_modules/tsx/dist/cli.mjs'), 'apps/web/server.ts', '--production'], { cwd, env: { ...env, PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); running.stdout.resume(); running.stderr.resume();
      const origin = `http://127.0.0.1:${port}`; await waitForHealth(`${origin}/api/health`, running);
      const stageChecks = ['manifest-integrity', 'frozen-offline-install', 'production-health'];
      if (stage === 'candidate') { const ready = await fetch(`${origin}/api/readiness`); const value = await ready.json(); if (!ready.ok || value.status !== 'ready' || value.checks.worker !== 'ready') throw new Error('Integrated worker/storage readiness failed'); stageChecks.push('integrated-worker-storage-queue-readiness'); }
      const demoResponse = await fetch(`${origin}/api/demo`); if (!demoResponse.ok) throw new Error('Demo unavailable'); const demo = await demoResponse.json(); if (demo.mode !== 'demo' || demo.nodes.length !== 212) throw new Error('Unexpected demo fixture');
      const proposalResponse = await fetch(`${origin}/api/grouping`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ snapshotId: demo.id, enabled: true }) }); const proposal = await proposalResponse.json(); if (!proposalResponse.ok || proposal.status !== 'baseline') throw new Error('Provider-disable fallback failed');
      const home = await fetch(origin); if (!home.ok || !(await home.text()).includes('<div id="root"')) throw new Error('Production frontend unavailable');
      if (stage === 'candidate') { const metricsResponse = await fetch(`${origin}/api/metrics`); const value = await metricsResponse.json(); if (!metricsResponse.ok || value.scope !== 'owner-process-aggregate' || value.provider.outcomes.disabled !== 1 || value.provider.requests !== 0 || value.provider.costUsd !== null) throw new Error('Integrated disabled-provider operational observation failed'); stageChecks.push('disabled-provider-observed-zero-transfer'); }
      stageChecks.push('production-html', '212-file-demo', 'provider-disabled-baseline');
      results.push({ stage, artifact: manifest.id, commit: manifest.commit, checks: stageChecks, network: 'loopback-only application probes; package install offline', database: 'memory', externalModels: false }); await stop(running); running = undefined;
    }
    const report = { schemaVersion: '1', recordedAt: new Date().toISOString(), scope: 'local-source-artifact-rehearsal', results, stagingDatabase: 'not-verified', hostedDeployment: 'not-performed', retainedDirectory: directory };
    await writeFile(join(directory, 'rehearsal.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
  } catch { console.error('Release rehearsal failed. No hosted service or database was changed; retain the local .cache/release-rehearsal directory for inspection.'); process.exitCode = 1; }
  finally { if (running) await stop(running); }
}
