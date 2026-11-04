import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { RepositoryPathSchema } from '@patchwork/contracts';
import { parseRepository } from '@patchwork/github';
import { RepositoryMappingSchema } from './groups';
import { LOCAL_REF_PATTERN, runLocalGit } from './local-git';

/**
 * Server-side registry of local Git mirrors. HTTP input can only name a registered
 * repository id; it never supplies a filesystem path. Problems name the repository id
 * and the field, never a path, so diagnostics cannot reveal the machine layout.
 */
export class LocalConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Local repository configuration needs attention: ${problems.join(' ')}`);
    this.name = 'LocalConfigError';
  }
}

export const LOCAL_LIMIT_CEILINGS = Object.freeze({ maxFiles: 25_000, maxSourceFiles: 500, maxSourceBytes: 1_048_576, maxManifests: 50, maxSnapshotBytes: 67_108_864, workerHeapMb: 2_048, maxChangedFiles: 50_000, maxListedSources: 2_000 });
export const LOCAL_LIMIT_DEFAULTS = Object.freeze({ maxFiles: 10_000, maxSourceFiles: 500, maxSourceBytes: 80_000, maxManifests: 50, maxSnapshotBytes: 67_108_864, workerHeapMb: 1_024, maxChangedFiles: 25_000, maxListedSources: 1_000 });
export type LocalLimits = { -readonly [K in keyof typeof LOCAL_LIMIT_DEFAULTS]: number };
const MAX_CONFIG_BYTES = 1_048_576;
const MAX_MAPPING_BYTES = 1_048_576;
const MAX_FOOTPRINT_BYTES = 67_108_864;
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;

const bound = (max: number, min = 0) => z.number().int().min(min).max(max);
const LimitsSchema = z.object({
  maxFiles: bound(LOCAL_LIMIT_CEILINGS.maxFiles, 1), maxSourceFiles: bound(LOCAL_LIMIT_CEILINGS.maxSourceFiles), maxSourceBytes: bound(LOCAL_LIMIT_CEILINGS.maxSourceBytes, 1_000),
  maxManifests: bound(LOCAL_LIMIT_CEILINGS.maxManifests), maxSnapshotBytes: bound(LOCAL_LIMIT_CEILINGS.maxSnapshotBytes, 1_048_576), workerHeapMb: bound(LOCAL_LIMIT_CEILINGS.workerHeapMb, 128),
  maxChangedFiles: bound(LOCAL_LIMIT_CEILINGS.maxChangedFiles, 1), maxListedSources: bound(LOCAL_LIMIT_CEILINGS.maxListedSources, 1),
}).strict().partial();
const RepositoryLimitsSchema = LimitsSchema.omit({ maxSnapshotBytes: true, workerHeapMb: true });
const Pattern = z.string().min(1).max(300).refine(value => !value.includes('..') && !/[\u0000-\u001f\\]/.test(value), 'Invalid path pattern');
const RefSchema = z.string().regex(LOCAL_REF_PATTERN, 'Invalid branch or commit name');
const FilePath = z.string().min(1).max(4_096);

const RepositoryInputSchema = z.object({
  id: z.string().min(3).max(140),
  label: z.string().trim().min(1).max(80),
  gitDir: FilePath,
  defaultRef: RefSchema,
  include: z.array(Pattern).max(200).default([]),
  exclude: z.array(Pattern).max(200).default([]),
  mapping: FilePath.optional(),
  footprints: FilePath.optional(),
  footprintRepos: z.array(z.string().min(1).max(200)).max(50).optional(),
  limits: RepositoryLimitsSchema.optional(),
}).strict();
const ConfigSchema = z.object({
  version: z.literal(1),
  limits: LimitsSchema.optional(),
  repositories: z.array(z.unknown()).min(1).max(32),
}).strict();

export type FootprintStatus = 'added' | 'modified' | 'removed' | 'renamed';
export interface FootprintFile { path: string; status: FootprintStatus; additions?: number; deletions?: number; previousPath?: string; inHead?: boolean; note?: string; }
export interface FootprintRecord {
  /** Snapshot source id: pr:<n> or commit:<sha>. */
  key: string; kind: 'pr' | 'commit'; title: string; origin: string;
  number?: number; state?: string; updatedAt?: string;
  sha?: string; baseSha?: string; headSha?: string;
  files?: FootprintFile[]; notes: string[]; views: string[];
}
export interface FootprintView { id: string; title: string; description?: string; kind: 'pr' | 'commit' | 'mixed'; sourceIds: string[]; omitted: number; }
export interface LocalFootprints { records: FootprintRecord[]; views: FootprintView[]; problems: string[]; }
export interface LocalRepository {
  fullName: string; owner: string; name: string; label: string;
  /** Resolved real path of a bare mirror. Server/worker internal; never serialized to clients. */
  gitDir: string;
  defaultRef: string; include: string[]; exclude: string[];
  mapping?: unknown; footprints?: LocalFootprints; limits: LocalLimits;
  /** Hash of everything besides the commit that shapes a snapshot. */
  fingerprint: string;
}
export interface LocalGitRegistry {
  only: boolean; limits: LocalLimits; repositories: LocalRepository[];
  get(fullName: string): LocalRepository | undefined;
}
export interface PublicLocalConfig { enabled: boolean; only: boolean; repositories: { fullName: string; label: string; defaultRef: string }[]; limits?: LocalLimits }

export const localGitConfigPath = (env: NodeJS.ProcessEnv = process.env) => env.LOCAL_REPOS || undefined;
/** Local mode is local-only unless explicitly opened to GitHub with LOCAL_REPOS_ONLY=false. */
export const localGitOnly = (env: NodeJS.ProcessEnv = process.env) => (env.LOCAL_REPOS_ONLY ?? 'true') !== 'false';

const expandPath = (value: string, base: string) => resolve(base, value.startsWith('~/') ? `${homedir()}/${value.slice(2)}` : value);
async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  const real = await realpath(path); const info = await stat(real);
  if (!info.isFile() || info.size > maxBytes) throw new Error('unreadable');
  return readFile(real);
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex').slice(0, 20);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const normalizeDate = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/(\.\d{3})\d+/, '$1');
  return Number.isFinite(Date.parse(trimmed)) ? new Date(Date.parse(trimmed)).toISOString() : undefined;
};

function normalizeFile(input: unknown): FootprintFile | undefined {
  if (!isRecord(input) || !RepositoryPathSchema.safeParse(input.path).success) return undefined;
  // Full names or Git name-status letters (A, M, D, R100).
  const raw = String(input.status ?? 'modified').toLowerCase();
  const previousPath = RepositoryPathSchema.safeParse(input.previousPath).success ? input.previousPath as string : undefined;
  let status: FootprintStatus = raw === 'added' || raw === 'a' ? 'added' : raw === 'removed' || raw === 'deleted' || raw === 'd' ? 'removed' : raw.startsWith('renamed') || raw.startsWith('r') ? 'renamed' : 'modified';
  if (status === 'renamed' && !previousPath) status = 'modified';
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  let additions = count(input.additions), deletions = count(input.deletions);
  if (status === 'added') deletions = 0;
  if (status === 'removed') additions = 0;
  return { path: input.path as string, status, ...(additions !== undefined ? { additions } : {}), ...(deletions !== undefined ? { deletions } : {}), ...(status === 'renamed' && previousPath ? { previousPath } : {}), ...(input.inHead === false ? { inHead: false } : {}), ...(text(input.note, 200) ? { note: text(input.note, 200) } : {}) };
}
const notesOf = (value: unknown) => Array.isArray(value) ? value.flatMap(item => text(item, 200) ?? []).slice(0, 20) : [];

/**
 * Reads a footprint file: { schemaVersion: 1, pulls, commits, views }.
 * - pulls: { number, title?, state?, updatedAt?, baseSha?, headSha?, origin?, repo?, notes?, files? }
 * - commits: { sha, title?, state?, updatedAt?, origin?, repo?, notes?, files? }
 * - files: { path, status, additions?, deletions?, previousPath?, inHead?, note? }
 * - views: { id, title?, description?, sources: [{ kind: 'pr' | 'commit', ...a pull or commit }] };
 *   a source may also reference a listed pull or commit by number or sha alone.
 * Records are validated and de-duplicated across lists and views; anything dropped is
 * counted in problems, never silently ignored.
 */
export function normalizeFootprints(input: unknown, repoFilter?: string[], maxRecords: number = LOCAL_LIMIT_DEFAULTS.maxListedSources): LocalFootprints {
  if (!isRecord(input)) throw new Error('not an object');
  const records = new Map<string, FootprintRecord>(); const views: FootprintView[] = []; const problems: string[] = [];
  let invalidRecords = 0, invalidFiles = 0, filtered = 0, overflow = 0;
  const matchesRepo = (repo: unknown) => !repoFilter?.length || (typeof repo === 'string' && repoFilter.some(rule => rule.endsWith('*') ? repo.startsWith(rule.slice(0, -1)) : repo === rule));
  const add = (raw: Record<string, unknown>, kindHint: unknown, view?: string): string | undefined => {
    const kind = kindHint === 'pr' ? 'pr' : kindHint === 'commit' ? 'commit' : undefined;
    let key: string | undefined, number: number | undefined, sha: string | undefined;
    if (kind === 'pr') {
      number = Number(raw.number);
      if (Number.isSafeInteger(number) && number >= 1) key = `pr:${number}`;
    } else if (kind === 'commit' && typeof raw.sha === 'string' && SHA.test(raw.sha)) {
      sha = raw.sha.toLowerCase(); key = `commit:${sha}`;
    }
    // A source without its own repo may reference a record that is already listed.
    const existing = key ? records.get(key) : undefined;
    if (existing && (raw.repo === undefined || matchesRepo(raw.repo))) { if (view && !existing.views.includes(view)) existing.views.push(view); return key; }
    if (!matchesRepo(raw.repo)) { filtered++; return undefined; }
    if (!key || !kind) { invalidRecords++; return undefined; }
    if (records.size >= maxRecords) { overflow++; return undefined; }
    let files: FootprintFile[] | undefined;
    if (Array.isArray(raw.files)) {
      const seen = new Set<string>(); files = [];
      for (const item of raw.files.slice(0, LOCAL_LIMIT_CEILINGS.maxChangedFiles)) {
        const file = normalizeFile(item);
        if (!file || seen.has(file.path)) { invalidFiles++; continue; }
        seen.add(file.path); files.push(file);
      }
      if (raw.files.length > LOCAL_LIMIT_CEILINGS.maxChangedFiles) invalidFiles += raw.files.length - LOCAL_LIMIT_CEILINGS.maxChangedFiles;
    }
    const headCandidate = kind === 'pr' ? raw.headSha : sha;
    records.set(key, {
      key, kind, title: text(raw.title, 300) ?? key, origin: text(raw.origin, 500) ?? 'footprint file',
      ...(number !== undefined ? { number } : {}), ...(text(raw.state, 40) ? { state: text(raw.state, 40) } : {}),
      ...(normalizeDate(raw.updatedAt) ? { updatedAt: normalizeDate(raw.updatedAt) } : {}),
      ...(sha ? { sha } : {}),
      ...(typeof raw.baseSha === 'string' && SHA.test(raw.baseSha) ? { baseSha: raw.baseSha.toLowerCase() } : {}),
      ...(typeof headCandidate === 'string' && SHA.test(headCandidate) ? { headSha: headCandidate.toLowerCase() } : {}),
      ...(files ? { files } : {}), notes: notesOf(raw.notes), views: view ? [view] : [],
    });
    return key;
  };
  // Pulls and commits first, so a view source may reference one by number or sha alone.
  for (const pull of Array.isArray(input.pulls) ? input.pulls : []) { if (isRecord(pull)) add(pull, 'pr'); else invalidRecords++; }
  for (const commit of Array.isArray(input.commits) ? input.commits : []) { if (isRecord(commit)) add(commit, 'commit'); else invalidRecords++; }
  if (Array.isArray(input.views)) {
    for (const rawView of input.views.slice(0, 50)) {
      if (!isRecord(rawView) || !Array.isArray(rawView.sources)) { invalidRecords++; continue; }
      const id = text(rawView.id, 80) ?? `view-${views.length + 1}`;
      const keys: string[] = []; const kinds = new Set<string>();
      for (const source of rawView.sources) {
        if (!isRecord(source)) { invalidRecords++; continue; }
        const key = add(source, source.kind, id);
        if (key && !keys.includes(key)) { keys.push(key); kinds.add(records.get(key)!.kind); }
      }
      if (keys.length) views.push({ id, title: text(rawView.title, 200) ?? id, ...(text(rawView.description, 2_000) ? { description: text(rawView.description, 2_000) } : {}), kind: kinds.size === 1 ? [...kinds][0] as 'pr' | 'commit' : 'mixed', sourceIds: keys.slice(0, 20), omitted: Math.max(0, keys.length - 20) });
    }
  }
  if (!Array.isArray(input.views) && !Array.isArray(input.pulls) && !Array.isArray(input.commits)) throw new Error('no records');
  if (invalidRecords) problems.push(`${invalidRecords} footprint records were invalid and are not listed.`);
  if (invalidFiles) problems.push(`${invalidFiles} footprint file rows were invalid, duplicated or over the per-record limit and are not shown.`);
  if (overflow) problems.push(`${overflow} footprint records exceed the listing limit of ${maxRecords} and are not listed.`);
  if (filtered && !records.size) problems.push('No footprint records matched this repository.');
  return { records: [...records.values()], views, problems };
}

async function loadRepository(raw: unknown, index: number, base: string, globalLimits: LocalLimits, problems: string[]): Promise<LocalRepository | undefined> {
  const parsed = RepositoryInputSchema.safeParse(raw);
  if (!parsed.success) { problems.push(`Repository entry ${index + 1} is invalid (${[...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'entry'))].join(', ')}).`); return undefined; }
  const entry = parsed.data; let address;
  try { address = parseRepository(entry.id); } catch { problems.push(`Repository entry ${index + 1} needs an id in owner/name form.`); return undefined; }
  const label = `Repository ${address.fullName}`;
  let gitDir: string;
  try {
    gitDir = await realpath(expandPath(entry.gitDir, base));
    if (!(await stat(gitDir)).isDirectory()) throw new Error('not a directory');
    const bare = (await runLocalGit(gitDir, ['rev-parse', '--is-bare-repository'], { timeoutMs: 15_000, maxOutputBytes: 64 })).toString('utf8').trim();
    if (bare !== 'true') { problems.push(`${label}: gitDir must be a bare mirror (git clone --mirror), not a working tree.`); return undefined; }
  } catch { problems.push(`${label}: gitDir is not a readable Git directory.`); return undefined; }
  try { await runLocalGit(gitDir, ['rev-parse', '--verify', '--quiet', `${entry.defaultRef}^{commit}`], { timeoutMs: 15_000, maxOutputBytes: 256 }); }
  catch { problems.push(`${label}: defaultRef ${entry.defaultRef} does not resolve to a commit in the mirror.`); return undefined; }
  const limits: LocalLimits = { ...globalLimits, ...(entry.limits ?? {}) };
  let mapping: unknown, mappingHash = '';
  if (entry.mapping) {
    try { const bytes = await readBounded(expandPath(entry.mapping, base), MAX_MAPPING_BYTES); mapping = RepositoryMappingSchema.parse(JSON.parse(bytes.toString('utf8'))); mappingHash = hash(bytes); }
    catch { problems.push(`${label}: the island mapping file is unreadable or is not a valid version 1 mapping.`); return undefined; }
  }
  let footprints: LocalFootprints | undefined, footprintHash = '';
  if (entry.footprints) {
    try { const bytes = await readBounded(expandPath(entry.footprints, base), MAX_FOOTPRINT_BYTES); footprints = normalizeFootprints(JSON.parse(bytes.toString('utf8')), entry.footprintRepos, limits.maxListedSources); footprintHash = hash(bytes); }
    catch { problems.push(`${label}: the footprint file is unreadable or has no pull or commit records.`); return undefined; }
  }
  const fingerprint = hash(JSON.stringify([address.fullName, limits, entry.include, entry.exclude, mappingHash, footprintHash, entry.footprintRepos ?? []]));
  return { fullName: address.fullName, owner: address.owner, name: address.name, label: entry.label, gitDir, defaultRef: entry.defaultRef, include: entry.include, exclude: entry.exclude, ...(mapping !== undefined ? { mapping } : {}), ...(footprints ? { footprints } : {}), limits, fingerprint };
}

export async function loadLocalGitConfig(configPath: string, options: { only?: boolean } = {}): Promise<LocalGitRegistry> {
  if (!isAbsolute(configPath)) throw new LocalConfigError(['LOCAL_REPOS must be an absolute path to a JSON file.']);
  let input: unknown;
  try { input = JSON.parse((await readBounded(configPath, MAX_CONFIG_BYTES)).toString('utf8')); }
  catch { throw new LocalConfigError(['The local repository file is unreadable, larger than 1 MiB, or not valid JSON.']); }
  const parsed = ConfigSchema.safeParse(input);
  if (!parsed.success) throw new LocalConfigError([`The local repository file is invalid (${[...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'root'))].slice(0, 8).join(', ')}).`]);
  const limits: LocalLimits = { ...LOCAL_LIMIT_DEFAULTS, ...(parsed.data.limits ?? {}) };
  const problems: string[] = []; const base = dirname(await realpath(configPath));
  const repositories: LocalRepository[] = [];
  for (const [index, raw] of parsed.data.repositories.entries()) {
    const repository = await loadRepository(raw, index, base, limits, problems);
    if (!repository) continue;
    if (repositories.some(item => item.fullName.toLowerCase() === repository.fullName.toLowerCase())) { problems.push(`Repository ${repository.fullName} is listed twice.`); continue; }
    repositories.push(repository);
  }
  if (problems.length) throw new LocalConfigError(problems);
  const byName = new Map(repositories.map(repository => [repository.fullName.toLowerCase(), repository]));
  return { only: options.only ?? true, limits, repositories, get: fullName => { try { return byName.get(parseRepository(fullName).fullName.toLowerCase()); } catch { return undefined; } } };
}

const registries = new Map<string, Promise<LocalGitRegistry>>();
const loaded = new Map<string, LocalGitRegistry>();
const registryKey = (env: NodeJS.ProcessEnv) => { const path = localGitConfigPath(env); return path ? JSON.stringify([path, localGitOnly(env)]) : undefined; };
/** Process-wide registry for the configured file; undefined when local mode is off. */
export function loadLocalGitRegistry(env: NodeJS.ProcessEnv = process.env): Promise<LocalGitRegistry | undefined> {
  const key = registryKey(env);
  if (!key) return Promise.resolve(undefined);
  let pending = registries.get(key);
  if (!pending) {
    pending = loadLocalGitConfig(localGitConfigPath(env)!, { only: localGitOnly(env) });
    registries.set(key, pending);
    pending.then(registry => { loaded.set(key, registry); }, () => { registries.delete(key); });
  }
  return pending;
}
/** The registry this process already loaded (the server loads it at startup), without waiting. */
export function currentLocalGitRegistry(env: NodeJS.ProcessEnv = process.env): LocalGitRegistry | undefined {
  const key = registryKey(env);
  return key ? loaded.get(key) : undefined;
}

/** Client-safe description: ids, labels, refs and limits only. */
export function publicLocalConfig(registry?: LocalGitRegistry): PublicLocalConfig {
  if (!registry) return { enabled: false, only: false, repositories: [] };
  return { enabled: true, only: registry.only, repositories: registry.repositories.map(repository => ({ fullName: repository.fullName, label: repository.label, defaultRef: repository.defaultRef })), limits: { ...registry.limits } };
}
