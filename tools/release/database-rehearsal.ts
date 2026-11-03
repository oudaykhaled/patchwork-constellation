import { Client } from 'pg';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createStore, newJob, type SnapshotStore } from '@patchwork/storage';
import { demoSnapshot } from '@patchwork/fixtures';

/** Opt-in disposable local service rehearsal. Secret values never enter argv or this report. */
const digest = (value: unknown): string => {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object' ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical((input as Record<string, unknown>)[key])])) : input;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
};
async function main() {
  const configured = process.env.TEST_DATABASE_URL, bin = process.env.PG_REHEARSAL_BIN_DIR, outputRoot = process.env.PG_REHEARSAL_ROOT;
  if (process.env.PG_PROCESS_REHEARSAL !== '1' || !configured || !bin || !outputRoot) throw new Error('Protected local rehearsal configuration required');
  const connection = new URL(configured);
  if (connection.protocol !== 'postgresql:' && connection.protocol !== 'postgres:' || connection.hostname !== '127.0.0.1' || connection.port !== '55438' || !/^\/constellation_[a-z0-9_]+$/.test(connection.pathname)) throw new Error('Only the named disposable local PostgreSQL service is allowed');
  const suffix = randomUUID().replaceAll('-', '').slice(0, 20), sourceName = `constellation_release_${suffix}_source`, restoredName = `constellation_release_${suffix}_restored`;
  const names = [sourceName, restoredName], created = new Set<string>(); const admin = new Client({ connectionString: configured, connectionTimeoutMillis: 5_000, query_timeout: 10_000 });
  const databaseUrl = (name: string) => { const url = new URL(configured); url.pathname = '/' + name; return url.href; };
  const connect = async (name: string) => { const client = new Client({ connectionString: databaseUrl(name), connectionTimeoutMillis: 5_000, query_timeout: 10_000 }); await client.connect(); return client; };
  const native = (name: 'pg_dump' | 'pg_restore', args: string[], database: string) => new Promise<void>((resolvePromise, reject) => {
    const executable = join(resolve(bin), name + (process.platform === 'win32' ? '.exe' : ''));
    const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore', env: { ...process.env, PGHOST: connection.hostname, PGPORT: connection.port, PGUSER: decodeURIComponent(connection.username), PGDATABASE: database, PGPASSWORD: process.env.PGPASSWORD ?? decodeURIComponent(connection.password), PGCONNECT_TIMEOUT: '5' } });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Native database rehearsal command exceeded its deadline')); }, 30_000);
    child.once('error', () => { clearTimeout(timeout); reject(new Error('Native database rehearsal command unavailable')); }); child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolvePromise() : reject(new Error('Native database rehearsal command failed')); });
  });
  const migrations = (await readdir(resolve('database/migrations'))).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!migrations.includes('001_storage.sql') || !migrations.includes('002_webhook_inbox.sql')) throw new Error('Integrated storage and webhook migrations are required');
  const migrate = async (client: Client) => { await client.query('BEGIN'); try { for (const name of migrations) await client.query(await readFile(resolve('database/migrations', name), 'utf8')); await client.query('COMMIT'); } catch { await client.query('ROLLBACK'); throw new Error('Disposable database migration failed'); } };
  let source: SnapshotStore | undefined, restored: SnapshotStore | undefined, report: Record<string, unknown> | undefined, dropped = 0;
  const dump = join(resolve(outputRoot), `release-${suffix}.dump`);
  try {
    await admin.connect(); const version = (await admin.query('SHOW server_version')).rows[0]?.server_version as string;
    for (const name of names) { if (!/^constellation_release_[a-f0-9]{20}_(?:source|restored)$/.test(name)) throw new Error('Unsafe disposable database identifier'); await admin.query(`CREATE DATABASE "${name}"`); created.add(name); }
    const sourceClient = await connect(sourceName); try { await migrate(sourceClient); } finally { await sourceClient.end(); }
    source = await createStore({ databaseUrl: databaseUrl(sourceName), autoMigrate: false });
    const scope = { ownerId: 'release-rehearsal-synthetic', repository: demoSnapshot.repository.fullName.toLowerCase() }; const snapshot = structuredClone(demoSnapshot);
    await source.putSnapshot(scope, snapshot); const job = newJob({ repository: scope.repository, contextRef: snapshot.contextSha }, { id: 'release-rehearsal-synthetic-job' }); job.status = 'ready'; job.progress = 100; job.snapshotId = snapshot.id; await source.putJob(scope, job);
    const inboxClient = await connect(sourceName); try {
      await inboxClient.query("INSERT INTO patchwork_webhook_inbox(delivery_id,payload,status,expires_at) VALUES($1,$2::jsonb,'queued',NOW()+INTERVAL '1 day')", ['release-rehearsal-synthetic-delivery', JSON.stringify({ schemaVersion: '1', synthetic: true })]);
      await inboxClient.query("INSERT INTO patchwork_refresh_state(owner_id,repository,revision,payload,expires_at) VALUES($1,$2,1,$3::jsonb,NOW()+INTERVAL '1 day')", [scope.ownerId, scope.repository, JSON.stringify({ schemaVersion: '1', synthetic: true })]);
    } finally { await inboxClient.end(); }
    const sourceSnapshot = await source.getSnapshot(scope, snapshot.id), sourceJob = await source.getJob(scope, job.id); await source.close(); source = undefined;
    await native('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', dump], sourceName);
    await native('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '--dbname', restoredName, dump], restoredName);
    const restoredClient = await connect(restoredName); let counts: Record<string, number> = {}; try {
      for (const table of ['patchwork_snapshots', 'patchwork_jobs', 'patchwork_webhook_inbox', 'patchwork_refresh_state']) counts[table] = Number((await restoredClient.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0]?.count);
      await migrate(restoredClient); // An installed compatible schema can accept the same migration set again.
    } finally { await restoredClient.end(); }
    restored = await createStore({ databaseUrl: databaseUrl(restoredName), autoMigrate: false }); const restoredSnapshot = await restored.getSnapshot(scope, snapshot.id), restoredJob = await restored.getJob(scope, job.id);
    if (!sourceSnapshot || !sourceJob || digest(sourceSnapshot) !== digest(restoredSnapshot) || digest(sourceJob) !== digest(restoredJob) || Object.values(counts).some(value => value !== 1)) throw new Error('Restored synthetic records differ');
    const dumpBytes = await readFile(dump);
    report = { schemaVersion: '1', recordedAt: new Date().toISOString(), scope: 'disposable-local-postgresql-release-rehearsal', outcome: 'passed', serverVersion: version, migrations, checks: ['fresh-database-migration', 'synthetic-scoped-snapshot-and-job', 'synthetic-webhook-and-refresh-state', 'native-custom-backup', 'native-fresh-database-restore', 'snapshot-and-job-digest-equality', 'all-four-table-counts', 'idempotent-migration-after-restore'], counts, snapshotDigest: digest(restoredSnapshot), jobDigest: digest(restoredJob), backupSha256: createHash('sha256').update(dumpBytes).digest('hex'), backupBytes: (await stat(dump)).size, sourceData: 'synthetic-only', liveDatabaseOverwritten: false, hostedDeployment: false, credentialsRetained: false };
  } finally {
    await Promise.allSettled([source?.close(), restored?.close()]);
    for (const name of [...created].reverse()) { if (!names.includes(name) || !/^constellation_release_[a-f0-9]{20}_(?:source|restored)$/.test(name)) throw new Error('Unsafe disposable cleanup'); await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); dropped++; }
    await admin.end();
  }
  if (!report || dropped !== 2) throw new Error('Disposable rehearsal incomplete'); report.cleanup = { disposableDatabasesDropped: dropped };
  await writeFile(join(resolve(outputRoot), 'release-restore-result.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report, null, 2));
}
main().catch(() => { console.error('Disposable local database release rehearsal failed. No existing database was selected for overwrite; inspect protected local evidence without publishing credentials.'); process.exitCode = 1; });
