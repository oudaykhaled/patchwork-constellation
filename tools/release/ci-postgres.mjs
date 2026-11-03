import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';

// Runner-owned, disposable loopback PostgreSQL only. Never handles production credentials.
async function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux' || !process.env.RUNNER_TEMP || !process.env.GITHUB_ENV || !/^\d+$/.test(process.env.GITHUB_RUN_ID || '') || !/^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT || '')) throw new Error('Ephemeral GitHub runner context required');
  const base = resolve(process.env.RUNNER_TEMP), root = resolve(base, `constellation-stage-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`), data = join(root, 'data');
  if (!root.startsWith(base + sep)) throw new Error('Staging directory escaped runner temporary space');
  const metadataPath = join(root, 'postgres.json');
  if (process.argv[2] === 'stop') {
    let value; try { value = JSON.parse(await readFile(metadataPath, 'utf8')); } catch { return; }
    if (!/^\/usr\/lib\/postgresql\/\d+\/bin$/.test(value.bin)) throw new Error('Unexpected PostgreSQL binary directory');
    execFileSync(join(value.bin, 'pg_ctl'), ['-D', data, '-w', '-t', '30', '-m', 'fast', 'stop'], { stdio: 'ignore' });
    console.log('Owned ephemeral staging PostgreSQL stopped.'); return;
  }
  if (process.argv[2] !== 'start') throw new Error('Use start or stop');
  const versions = (await readdir('/usr/lib/postgresql')).filter(name => /^\d+$/.test(name)).sort((a, b) => Number(b) - Number(a));
  let bin;
  for (const version of versions) { const possible = `/usr/lib/postgresql/${version}/bin`; try { await readFile(join(possible, 'initdb')); bin = possible; break; } catch { /* Try the next actual installed server. */ } }
  if (!bin) throw new Error('The official runner image lacks a native PostgreSQL server');
  await mkdir(root, { recursive: false, mode: 0o700 }); const password = randomBytes(32).toString('base64url'), passwordFile = join(root, 'password');
  await writeFile(passwordFile, password, { flag: 'wx', mode: 0o600 });
  execFileSync(join(bin, 'initdb'), ['-D', data, '--username=constellation_stage_admin', '--auth=scram-sha-256', '--pwfile', passwordFile], { stdio: 'ignore' });
  // Distro builds may default to a root/postgres-owned Unix socket directory.
  // This cluster is owned by the unprivileged runner and uses TCP loopback only.
  await appendFile(join(data, 'postgresql.conf'), "\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = ''\nport = 55438\nmax_connections = 30\nshared_buffers = '64MB'\n");
  await writeFile(metadataPath, JSON.stringify({ bin, root, data, ephemeral: true }) + '\n', { flag: 'wx', mode: 0o600 });
  execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-w', '-t', '30', '-l', join(root, 'server.log'), 'start'], { stdio: 'ignore' });
  const env = { ...process.env, PGHOST: '127.0.0.1', PGPORT: '55438', PGUSER: 'constellation_stage_admin', PGPASSWORD: password, PGCONNECT_TIMEOUT: '5' };
  execFileSync(join(bin, 'createdb'), ['constellation_staging_base'], { env, stdio: 'ignore' });
  console.log(`::add-mask::${password}`);
  await appendFile(process.env.GITHUB_ENV, `TEST_DATABASE_URL=postgresql://constellation_stage_admin:${password}@127.0.0.1:55438/constellation_staging_base\nPG_REHEARSAL_BIN_DIR=${bin}\nPG_PROCESS_REHEARSAL=1\nSTAGING_REHEARSAL=1\n`);
  console.log('Owned SCRAM PostgreSQL started on loopback55438; connection value masked and supplied only to this job.');
}
main().catch(() => { console.error('Ephemeral staging PostgreSQL setup/cleanup failed; no external service or existing database was selected.'); process.exitCode = 1; });
