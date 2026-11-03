import type { GraphSnapshot, Group } from '@patchwork/contracts';

export type GroupingOperation =
  | { type: 'rename'; groupId: string; label: string }
  | { type: 'move'; fileIds: string[]; groupId: string }
  | { type: 'merge'; groupIds: string[]; label: string }
  | { type: 'split'; groupId: string; fileIds: string[]; label: string };

export interface MembershipDecision {
  fileId: string;
  groupId: string;
  origin: 'rules' | 'ai-jev' | 'manual';
  evidenceIds: string[];
  confidence?: number;
  model?: string;
  rationale: string;
}

export interface GroupingProposal {
  id: string;
  snapshotId: string;
  parentRevisionId: string | null;
  status: 'proposed' | 'baseline';
  origin: 'rules' | 'ai-jev';
  groups: Group[];
  membership: Record<string, string>;
  decisions: MembershipDecision[];
  message: string;
  createdAt: string;
  models?: { generative: string; jev: string };
  usage?: { inputTokens: number; outputTokens: number; requests: number };
  dataPolicy: { fieldsSent: string[]; excludedFiles: number; analyzedFiles: number };
}

export interface GroupingRevision {
  id: string;
  snapshotId: string;
  parentRevisionId: string | null;
  origin: 'rules' | 'ai-jev' | 'manual';
  groups: Group[];
  membership: Record<string, string>;
  lockedFileIds: string[];
  lockedGroupIds: string[];
  createdAt: string;
}

export interface GroupingResult { snapshot: GraphSnapshot; revision: GroupingRevision }
export interface RequestContext { tenantId?: string; signal?: AbortSignal; expectedRevisionId?: string }
export interface GroupingConfig {
  enabled?: boolean;
  jevApiKey?: string;
  jevModel?: string;
  generativeApiKey?: string;
  generativeModel?: string;
  /** Local deployment only. Use a durable shared store before horizontal scaling. */
  storagePath?: string;
  fetch?: typeof fetch;
  maxFiles?: number;
  maxRequestsPerAnalysis?: number;
  maxRequestsPerTenant?: number;
  maxInputCharacters?: number;
  minimumConfidence?: number;
  timeoutMs?: number;
}

export class GroupingError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'GroupingError'; }
}
