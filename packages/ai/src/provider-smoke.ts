import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateLabels, LABEL_PROMPT_VERSION, MEMBERSHIP_PROMPT_VERSION, PROVIDER_CONTRACT_VERSION, TypeSafeDecisionProvider, type EvidenceBundle, type RequestBudget } from './providers';
import { GroupingError } from './types';

/** Synthetic metadata only. This command is opt-in and never reads repository files. */
export async function runProviderSmoke(options: { args: string[]; env: NodeJS.ProcessEnv; fetch?: typeof fetch }) {
  const { args, env } = options;
  const gates = {
    liveCallAuthorized: args.includes('--live'),
    dataTermsOperatorAttestation: args.includes('--reviewed-data-terms'),
    accountLimitsOperatorAttestation: args.includes('--reviewed-account-limits'),
    credentialsConfigured: Boolean(env.TYPESAFE_API_KEY?.trim() && env.OPENAI_API_KEY?.trim()),
    modelsPinned: Boolean(env.JEV_MODEL?.trim() === env.JEV_MODEL && env.OPENAI_MODEL?.trim() === env.OPENAI_MODEL && /^jev-\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(env.JEV_MODEL ?? '') && /^[a-zA-Z0-9][a-zA-Z0-9.-]*-\d{4}-\d{2}-\d{2}$/.test(env.OPENAI_MODEL ?? '')),
  };
  const report = {
    schemaVersion: '1', kind: 'provider-smoke', status: 'blocked', gates,
    contractVersion: PROVIDER_CONTRACT_VERSION,
    promptVersions: { labels: LABEL_PROMPT_VERSION, membership: MEMBERSHIP_PROMPT_VERSION },
    budget: { maximumRequests: 3, maximumCharactersPerRequest: 6000, maximumGenerativeOutputTokens: 256, deadlineMs: 30_000 },
    qualityEvaluation: 'not-performed',
  };
  if (Object.values(gates).some(value => !value)) return { ...report, code: 'INTEGRATION_GATE_REQUIRED', message: 'No network requests sent. Supply both pinned providers and explicitly attest authorization, reviewed data terms and account limits.' };
  const started = performance.now();
  const budget: RequestBudget = {
    fetch: options.fetch ?? fetch, timeoutMs: 8000, signal: AbortSignal.timeout(30_000), requests: 0,
    maxRequests: 3, maxInputCharacters: 6000, reserveRequest() {},
  };
  const evidence: EvidenceBundle = {
    files: [{ id: 'synthetic-file', path: 'sample/auth.ts', groupId: 'synthetic-auth', evidenceId: 'file:synthetic-file', imports: [] }],
    groups: [{ id: 'synthetic-auth', label: 'Auth', paths: ['sample/auth.ts'] }], allowedEvidenceIds: ['file:synthetic-file'],
  };
  try {
    const provider = new TypeSafeDecisionProvider({ apiKey: env.TYPESAFE_API_KEY!, model: env.JEV_MODEL! });
    const models = await provider.discover(budget);
    const generated = await generateLabels({ apiKey: env.OPENAI_API_KEY!, model: env.OPENAI_MODEL!, maxOutputTokens: 256 }, evidence, budget);
    if (generated.model !== env.OPENAI_MODEL) throw new GroupingError('MODEL_MISMATCH', 'The generative response did not match the pinned version.');
    const decided = await provider.decide({ synthetic: true, facts: ['This module has one file named sample/auth.ts.'] }, {
      membership: { type: 'choice', instructions: 'Choose the described module.', criteria: { auth: 'Authentication module', uncertain: 'Unsupported or uncertain' } },
      breadth: { type: 'score', instructions: 'How many files are stated?', criteria: ['One file', 'Several files'] },
      supported: { type: 'noul', instructions: 'Does the state explicitly name an auth file?' },
    }, budget);
    return {
      ...report, status: 'passed', requests: budget.requests, elapsedMs: Math.round(performance.now() - started),
      models: { configured: { jev: env.JEV_MODEL, generative: env.OPENAI_MODEL }, actual: { jev: decided.model, generative: generated.model }, discoveryCount: models.length },
      validatedPrimitives: ['choice', 'score', 'noul'],
      usage: { inputTokens: generated.usage.inputTokens + decided.usage.inputTokens, outputTokens: generated.usage.outputTokens + decided.usage.outputTokens },
      monetaryCost: 'not-measured; verify account billing',
      message: 'Transport and schema smoke passed on synthetic metadata. This does not pass the grouping quality or rollout gate.',
    };
  } catch (error) {
    return { ...report, status: 'failed', requests: budget.requests, elapsedMs: Math.round(performance.now() - started), code: error instanceof GroupingError ? error.code : 'SMOKE_FAILED', message: 'Provider smoke failed. No raw provider response, request, credential or repository content is included in this report.' };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { process.loadEnvFile('.env'); } catch { /* Optional; no raw configuration error is printed. */ }
  const report = await runProviderSmoke({ args: process.argv.slice(2), env: process.env });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}
