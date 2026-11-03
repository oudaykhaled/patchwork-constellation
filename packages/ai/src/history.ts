import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GraphSnapshot } from '@patchwork/contracts';
import { GroupingError, type GroupingRevision } from './types';

export interface GroupingHistoryMetadata {
  tenantId: string;
  repository: string;
  snapshotId: string;
  contextSha: string;
  files: Record<string, { path: string; blobSha?: string; presence?: string }>;
}
export interface StoredGroupingHistory { key: string; revisions: GroupingRevision[]; metadata?: GroupingHistoryMetadata }
export interface GroupingHistoryState { version: 2; generation: number; histories: StoredGroupingHistory[] }
const MAX_BYTES = 20_000_000;

/** Different authenticated owners must never share an in-memory registry or overwrite one file. */
export function ownerGroupingStoragePath(base: string | undefined, ownerId: string): string | undefined {
  if (!base) return undefined;
  if (ownerId === 'local-public') return base;
  return `${base}.${createHash('sha256').update(ownerId).digest('hex').slice(0, 32)}.json`;
}

export function historyMetadata(snapshot: GraphSnapshot, tenantId = 'local'): GroupingHistoryMetadata {
  return {
    tenantId, repository: snapshot.repository.fullName.toLowerCase(), snapshotId: snapshot.id, contextSha: snapshot.contextSha,
    files: Object.fromEntries(snapshot.nodes.map(node => [node.id, { path: node.path, ...(typeof node.blobSha === 'string' ? { blobSha: node.blobSha } : {}), ...(node.presence ? { presence: node.presence } : {}) }])),
  };
}

export function readGroupingHistory(path: string): GroupingHistoryState {
  if (!existsSync(path)) return { version: 2, generation: 0, histories: [] };
  try {
    if (statSync(path).size > MAX_BYTES) throw new Error('size');
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || typeof data !== 'object') throw new Error('shape');
    const value = data as Partial<GroupingHistoryState>;
    if (value.version !== 2 || !Number.isSafeInteger(value.generation) || value.generation! < 1 || !Array.isArray(value.histories) || value.histories.length > 100) throw new Error('shape');
    const keys = new Set<string>();
    for (const entry of value.histories) {
      if (typeof entry.key !== 'string' || !/^[a-f0-9]{64}$/.test(entry.key) || keys.has(entry.key) || !Array.isArray(entry.revisions) || !entry.revisions.length || entry.revisions.length > 20) throw new Error('shape');
      keys.add(entry.key);
      if (entry.metadata && (typeof entry.metadata.tenantId !== 'string' || typeof entry.metadata.repository !== 'string' || typeof entry.metadata.snapshotId !== 'string' || typeof entry.metadata.contextSha !== 'string' || !entry.metadata.files || typeof entry.metadata.files !== 'object' || Object.values(entry.metadata.files).some(file => !file || typeof file.path !== 'string' || file.path.length > 4096))) throw new Error('shape');
    }
    return value as GroupingHistoryState;
  } catch (error) {
    if (error instanceof GroupingError) throw error;
    throw new GroupingError('STORAGE_ERROR', 'Saved grouping history is invalid. Restore a valid backup before editing.');
  }
}

/** Exclusive local lock + generation compare-and-swap prevents concurrent process lost updates. */
export function writeGroupingHistory(path: string, expectedGeneration: number, histories: StoredGroupingHistory[]): number {
  const lock = `${path}.lock`;
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    try { descriptor = openSync(lock, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new GroupingError('STORAGE_BUSY', 'Another process is saving grouping. Reload the current revision and retry.');
      throw error;
    }
    const current = readGroupingHistory(path);
    if (current.generation !== expectedGeneration) throw new GroupingError('REVISION_CONFLICT', 'Grouping changed in another process. Reload the current revision before editing.');
    const generation = expectedGeneration + 1;
    const data = JSON.stringify({ version: 2, generation, histories });
    if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('size');
    const file = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(file, data, 'utf8'); fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporary, path);
    return generation;
  } catch (error) {
    if (error instanceof GroupingError) throw error;
    throw new GroupingError('STORAGE_ERROR', 'Grouping changes could not be saved. The previous revision is retained.');
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    if (descriptor !== undefined) { closeSync(descriptor); unlinkSync(lock); }
  }
}
