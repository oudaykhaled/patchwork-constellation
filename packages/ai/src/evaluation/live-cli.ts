import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { decideMembership, discoverJevModel, generateLabels, type RequestBudget } from '../providers';
import { EVALUATION_CORPUS, corpusDigest } from './corpus';
import { EVALUATION_VERSIONS, QUALITY_TARGETS } from '../evaluation-gate';
import { evaluationContext } from './live-report';

try { process.loadEnvFile('.env'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The local environment file could not be loaded.'); }

// No application or repository-provided text can invoke this collector. It is an explicit maintainer CLI.
const args = process.argv.slice(2);
const permitted = new Set(['--authorized', '--data-terms-reviewed', '--provider-hard-cost-cap-confirmed']);
if (args.some(value => !permitted.has(value) && !value.startsWith('--output='))) throw new Error('Unknown evaluation option.');
if (![...permitted].every(value => args.includes(value))) throw new Error('Live collection requires --authorized --data-terms-reviewed --provider-hard-cost-cap-confirmed. Configure the provider account spending cap first.');
const jevModel = process.env.JEV_MODEL; const generativeModel = process.env.OPENAI_MODEL;
const jevKey = process.env.TYPESAFE_API_KEY; const generativeKey = process.env.OPENAI_API_KEY;
if (!jevKey || !generativeKey || !jevModel || !/^jev-\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(jevModel) || !generativeModel || !/\d{4}-\d{2}-\d{2}$/.test(generativeModel)) throw new Error('Both server-side credentials and immutable model version names are required. No request was made.');
const ceiling = Number(process.env.EVAL_MAX_COST_USD);
const prices = {
  jevInput: Number(process.env.EVAL_JEV_INPUT_USD_PER_MILLION), jevOutput: Number(process.env.EVAL_JEV_OUTPUT_USD_PER_MILLION),
  generativeInput: Number(process.env.EVAL_GENERATIVE_INPUT_USD_PER_MILLION), generativeOutput: Number(process.env.EVAL_GENERATIVE_OUTPUT_USD_PER_MILLION),
};
if (!Number.isFinite(ceiling) || ceiling <= 0 || ceiling > 1 || Object.values(prices).some(value => !Number.isFinite(value) || value < 0)) throw new Error('Set explicit current account prices and EVAL_MAX_COST_USD in (0,1]. No request was made.');
let estimatedCostUsd = 0;
const budget: RequestBudget = {
  fetch, requests: 0, maxRequests: 20, maxInputCharacters: 12_000, timeoutMs: 15_000, signal: AbortSignal.timeout(180_000),
  reserveRequest: () => { if (estimatedCostUsd >= ceiling) throw new Error('Evaluation spend stop reached.'); },
};
const records = [];
try {
  await discoverJevModel(jevKey, jevModel, budget);
  for (const item of EVALUATION_CORPUS) {
    const { evidence, evidenceDigest } = evaluationContext(item);
    const start = performance.now();
    const generated = await generateLabels({ apiKey: generativeKey, model: generativeModel }, evidence, budget);
    estimatedCostUsd += (generated.usage.inputTokens * prices.generativeInput + generated.usage.outputTokens * prices.generativeOutput) / 1_000_000;
    if (generated.model !== generativeModel) throw new Error('Generative response did not match the pinned version.');
    if (estimatedCostUsd >= ceiling) throw new Error('Evaluation spend stop reached before Jev.');
    const decided = await decideMembership({ apiKey: jevKey, model: jevModel }, evidence, generated.labels, budget);
    estimatedCostUsd += (decided.usage.inputTokens * prices.jevInput + decided.usage.outputTokens * prices.jevOutput) / 1_000_000;
    records.push({ caseId: item.id, split: item.split, evidenceDigest, models: { jev: decided.model, generative: generated.model }, labels: generated.labels, decisions: decided.decisions, latencyMs: performance.now() - start, usage: { generative: generated.usage, jev: decided.usage } });
    if (estimatedCostUsd >= ceiling) throw new Error('Evaluation spend stop reached; inspect the partial observations before any retry.');
  }
} finally {
  const report = {
    schemaVersion: '2', kind: 'live-raw-observations', status: 'unreviewed', captureId: randomUUID(), completedAt: new Date().toISOString(),
    corpusDigest: corpusDigest(), tuningDigest: corpusDigest('tuning'), versions: EVALUATION_VERSIONS, targets: QUALITY_TARGETS,
    models: { jev: jevModel, generative: generativeModel }, requests: budget.requests, requestLimit: budget.maxRequests,
    estimatedCostUsd, spendStopUsd: ceiling, costLimitation: 'Local usage-based stop is checked between requests. The acknowledged provider-account hard cap is required to bound a single-call overrun; pricing is operator supplied. This file is not a release manifest.',
    records,
  };
  const target = resolve(args.find(value => value.startsWith('--output='))?.slice('--output='.length) ?? '.tmp/live-evaluation.json');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: 'unreviewed', completedCases: records.length, requests: budget.requests, estimatedCostUsd }) + '\n');
}
