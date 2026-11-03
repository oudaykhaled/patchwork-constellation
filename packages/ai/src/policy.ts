import { createHash } from 'node:crypto';
import type { FileNode, GraphSnapshot } from '@patchwork/contracts';
import { GroupingError } from './types';

export const AI_POLICY_VERSION = 'metadata-only-v2';
export const AI_PROMPT_VERSION = 'island-label-membership-v1';
export const AI_SCHEMA_VERSION = 'grouping-evidence-v1';
export const AI_FIELDS_SENT = ['file IDs and paths', 'existing island names', 'bounded import target IDs'];
const DEFAULT_EXCLUDED = /(^|\/)(?:\.env(?:\.[^/]*)?|\.git|node_modules|vendor|dist|build|coverage|generated|__generated__|secrets?|credentials?|private[-_]?keys?)(\/|$)|(?:\.min\.[^/]+|\.map|\.pem|\.key|\.p12|\.pfx|\.keystore)$/i;
// A conservative extra guard, not a claim that arbitrary filenames cannot contain secrets.
const SECRET_LIKE = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9_-]{20,}|(?:api[_-]?key|password|token|secret)\s*[:=]\s*[^\s]{8,})/i;
export const policyDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Configured patterns are bounded globs relative to the repository root, never executable regex. */
export function createExternalDataPolicy(excludedPaths: string[] = []) {
  if (excludedPaths.length > 64 || excludedPaths.some(path => typeof path !== 'string' || !path || path.length > 300 || path.includes('\\') || path.startsWith('/') || path.split('/').includes('..'))) throw new GroupingError('INVALID_CONFIG', 'AI exclusions must be bounded repository-relative glob paths.');
  const patterns = excludedPaths.slice().sort().map(path => {
    const escaped = path.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
    return new RegExp(`^(?:${escaped})(?:/|$)`, 'i');
  });
  const excludePath = (path: string) => DEFAULT_EXCLUDED.test(path) || SECRET_LIKE.test(path) || patterns.some(pattern => pattern.test(path));
  return {
    version: AI_POLICY_VERSION,
    digest: policyDigest({ version: AI_POLICY_VERSION, excludedPaths: excludedPaths.slice().sort() }),
    excludePath,
    excludeFile: (file: Pick<FileNode, 'id' | 'path'> & Partial<Pick<FileNode, 'groupId'>>) => excludePath(file.path) || SECRET_LIKE.test(file.id) || Boolean(file.groupId && SECRET_LIKE.test(file.groupId)),
    sanitizeLabel: (label: string, fallback: string) => SECRET_LIKE.test(label) || /[\u0000-\u001f<>]/.test(label) ? fallback : label.slice(0, 64),
  };
}

export function externalGroupingCacheKey(input: { tenantId: string; snapshot: GraphSnapshot; revisionId: string; evidence: unknown; jevModel?: string; generativeModel?: string; policyDigest: string; minimumConfidence: number; promptVersion?: string; schemaVersion?: string }): string {
  return policyDigest({ tenant: input.tenantId, repository: input.snapshot.repository.fullName.toLowerCase(), snapshot: input.snapshot.id, contextSha: input.snapshot.contextSha, revision: input.revisionId, evidenceDigest: policyDigest(input.evidence), jevModel: input.jevModel, generativeModel: input.generativeModel, policy: input.policyDigest, prompt: input.promptVersion ?? AI_PROMPT_VERSION, schema: input.schemaVersion ?? AI_SCHEMA_VERSION, providerContract: 'system-one-v2', labelPrompt: 'island-labels-v1', membershipPrompt: 'island-membership-v1', confidence: input.minimumConfidence });
}
