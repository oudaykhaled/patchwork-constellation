/** Opt-in live, public-only verification. Run: pnpm exec tsx packages/analysis/src/live-smoke.ts [owner/repository] */
import { analyzeRepository, loadSourceChanges } from './index';
const snapshot = await analyzeRepository({ repository: process.argv[2] ?? 'oudaykhaled/patchwork-constellation' }, { maxSourceFiles: 20 });
const firstCommit = snapshot.sources.find(source => source.kind === 'commit');
const loaded = firstCommit ? await loadSourceChanges(snapshot, 'commit', [firstCommit.id]) : snapshot;
const pullIds = snapshot.sources.filter(source => source.kind === 'pr').slice(0, 2).map(source => source.id);
const withPulls = pullIds.length ? await loadSourceChanges(loaded, 'pr', pullIds) : loaded;
console.log(JSON.stringify({ repository: withPulls.repository.fullName, contextSha: withPulls.contextSha, files: withPulls.nodes.length, groups: withPulls.groups.length, edges: withPulls.edges.length, sources: withPulls.sources.length, selectedCommit: firstCommit?.id, changedFiles: withPulls.sources.find(source => source.id === firstCommit?.id)?.files.length, pulls: withPulls.sources.filter(source => pullIds.includes(source.id)).map(source => ({ id: source.id, comparison: source.comparisonKind, base: source.baseSha, head: source.headSha, changedFiles: source.files.length })), coverage: withPulls.coverage }, null, 2));
