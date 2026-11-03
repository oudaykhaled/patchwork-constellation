import { z } from 'zod';
import type { GitHubTelemetry } from '@patchwork/github';

/** Worker observations are an allowlisted data message, never arbitrary repository output. */
export const GitHubTelemetrySchema = z.object({
  event: z.enum(['request', 'cache-hit', 'conditional-hit', 'deduplicated', 'retry', 'coverage']),
  resource: z.enum(['metadata', 'tree', 'blob', 'source', 'pulls', 'commits', 'comparison']),
  status: z.number().int().min(100).max(599).optional(),
  attempt: z.number().int().min(0).max(10).optional(),
  waitMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  remaining: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  resetAt: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  reason: z.enum(['recursive-tree-truncated', 'comparison-file-cap', 'pull-file-cap']).optional(),
}).strict();
export const WorkerTelemetrySchema = z.object({ type: z.literal('telemetry'), schemaVersion: z.literal('1'), channel: z.literal('github'), event: GitHubTelemetrySchema }).strict();
export function workerTelemetry(event: unknown) {
  const parsed = GitHubTelemetrySchema.safeParse(event);
  return parsed.success ? { type: 'telemetry' as const, schemaVersion: '1' as const, channel: 'github' as const, event: parsed.data } : undefined;
}
export function receiveWorkerTelemetry(message: unknown, observer?: (event: GitHubTelemetry) => void): boolean {
  const parsed = WorkerTelemetrySchema.safeParse(message); if (!parsed.success) return false;
  try { observer?.(parsed.data.event); } catch { /* Observability cannot change the analysis result. */ }
  return true;
}
