import { describe, expect, it } from 'vitest';
import { ANALYZER_VERSION, PARSER_VERSION } from '@patchwork/analysis';
import { IncrementalAnalysisBaselineSchema } from '@patchwork/contracts';
import { serializableWorkerOptions, type WorkerOptions } from './options';
const baseline = () => ({ schemaVersion: '1', repository: 'acme/tool', analyzerVersion: ANALYZER_VERSION, parserVersion: PARSER_VERSION, contextSha: 'a'.repeat(40), files: [{ path: 'src/index.ts', blobSha: 'b'.repeat(40), parseFacts: { schemaVersion: '1', scriptKind: 'ts', references: [{ specifier: './known', line: 1, kind: 'import' }], reasons: [] } }] });
describe('bounded worker options', () => {
  it('clones only explicit resource options and compatible thin metadata, without callbacks', () => {
    const raw = { token: 'outside-baseline-token', allowPrivate: true, maxFiles: 2_000, incrementalBaseline: baseline(), onTelemetry() {}, onProgress() {}, gitFallback() {}, gitComparisonFallback() {}, fetch() {}, unrecognized: 'PRIVATE_BAG_SENTINEL' };
    const serialized = serializableWorkerOptions(raw as unknown as WorkerOptions, 'acme/tool');
    expect(() => structuredClone(serialized)).not.toThrow(); expect(serialized.maxFiles).toBe(2_000);
    expect(IncrementalAnalysisBaselineSchema.parse(serialized.incrementalBaseline).files).toHaveLength(1);
    expect(JSON.stringify(serialized.incrementalBaseline)).not.toContain('outside-baseline-token');
    for (const key of ['signal', 'onTelemetry', 'onProgress', 'fetch', 'gitFallback', 'gitComparisonFallback', 'unrecognized']) expect(serialized).not.toHaveProperty(key);
  });
  it('never clones foreign, full-graph, oversize or malformed baselines', () => {
    for (const value of [{ ...baseline(), repository: 'foreign/private' }, { ...baseline(), token: 'PRIVATE_SENTINEL' }, { ...baseline(), nodes: [{ sourceText: 'PRIVATE_SENTINEL' }] }, { ...baseline(), raw: 'PRIVATE_SENTINEL'.repeat(150_000) }, { ...baseline(), files: [{ path: '../unsafe', sourceText: 'PRIVATE_SENTINEL' }] }]) {
      const serialized = serializableWorkerOptions({ incrementalBaseline: value }, 'acme/tool');
      expect(serialized.incrementalBaseline).toEqual({ schemaVersion: 'invalid' }); expect(JSON.stringify(serialized)).not.toMatch(/PRIVATE_SENTINEL|foreign\/private/);
    }
  });
  it('omits repository baselines from source-overlay workers and bounds resource controls', () => {
    expect(serializableWorkerOptions({ incrementalBaseline: baseline() })).not.toHaveProperty('incrementalBaseline');
    expect(() => serializableWorkerOptions({ maxFiles: 10_001 }, 'acme/tool')).toThrow('bounds');
    expect(() => serializableWorkerOptions({ maxRetries: 4 }, 'acme/tool')).toThrow('bounds');
  });
});
