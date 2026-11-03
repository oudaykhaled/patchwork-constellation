import { AstImportFactsSchema, IncrementalAnalysisBaselineSchema, INCREMENTAL_BASELINE_LIMITS, type GraphSnapshot, type IncrementalAnalysisBaseline } from '@patchwork/contracts';
import { PARSER_VERSION } from './imports';

export const ANALYZER_VERSION = 'static-v4';

/** Server-internal projection of an already authorized stored snapshot, never a request input. */
export function createIncrementalAnalysisBaseline(snapshot: GraphSnapshot): IncrementalAnalysisBaseline | undefined {
  if (snapshot.mode !== 'github' || snapshot.analyzerVersion !== ANALYZER_VERSION || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(snapshot.contextSha)) return undefined;
  const files: IncrementalAnalysisBaseline['files'] = []; let referenceCount = 0;
  const base = { schemaVersion: '1' as const, repository: snapshot.repository.fullName, analyzerVersion: ANALYZER_VERSION, parserVersion: PARSER_VERSION, contextSha: snapshot.contextSha, files };
  let bytes = new TextEncoder().encode(JSON.stringify(base)).byteLength;
  const paths = new Set<string>();
  for (const node of [...snapshot.nodes].sort((a, b) => a.path.localeCompare(b.path))) {
    if (files.length >= INCREMENTAL_BASELINE_LIMITS.maxFiles) break;
    if (node.presence !== 'context' || node.fileKind !== 'file' || !node.blobSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(node.blobSha) || node.parserVersion !== PARSER_VERSION) continue;
    const parsed = AstImportFactsSchema.safeParse(node.parseFacts);
    if (!parsed.success || referenceCount + parsed.data.references.length > INCREMENTAL_BASELINE_LIMITS.maxReferences) continue;
    if (paths.has(node.path)) continue;
    const file = { path: node.path, blobSha: node.blobSha, parseFacts: parsed.data };
    const additionalBytes = new TextEncoder().encode(JSON.stringify(file)).byteLength + (files.length ? 1 : 0);
    if (bytes + additionalBytes > INCREMENTAL_BASELINE_LIMITS.maxBytes) continue;
    files.push(file); paths.add(node.path); bytes += additionalBytes; referenceCount += parsed.data.references.length;
  }
  if (!files.length) return undefined;
  const result = IncrementalAnalysisBaselineSchema.safeParse(base);
  return result.success ? result.data : undefined;
}
