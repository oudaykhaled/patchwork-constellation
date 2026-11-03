/** Node-only authored Git corpus. No remote is contacted and no repository code is executed. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type HistoryChange = { status: 'A' | 'M' | 'D' | 'R100'; path: string; previousPath?: string };

// These expectations are declared from the operations below, not read from our analysis pipeline.
export const HISTORY_GOLDEN = {
  rootPaths: ['.gitmodules', 'assets/logo.bin', 'generated/schema.gen.ts', 'src/deleted.ts', 'src/legacy.ts', 'src/main.ts', 'src/shared.ts', 'vendor/widget'],
  featureA: [
    { status: 'M', path: 'assets/logo.bin' },
    { status: 'M', path: 'generated/schema.gen.ts' },
    { status: 'A', path: 'src/auth.ts' },
    { status: 'D', path: 'src/deleted.ts' },
    { status: 'R100', previousPath: 'src/legacy.ts', path: 'src/renamed.ts' },
    { status: 'M', path: 'src/shared.ts' },
    { status: 'M', path: 'vendor/widget' },
  ] satisfies HistoryChange[],
  featureB: [
    { status: 'A', path: 'src/billing.ts' },
    { status: 'M', path: 'src/shared.ts' },
  ] satisfies HistoryChange[],
  selectedUnionPaths: ['assets/logo.bin', 'generated/schema.gen.ts', 'src/auth.ts', 'src/billing.ts', 'src/deleted.ts', 'src/renamed.ts', 'src/shared.ts', 'vendor/widget'],
  overlapPaths: ['src/shared.ts'],
  unresolvedImports: [{ path: 'src/main.ts', specifier: './missing', line: 2 }],
  observedImportsAtRoot: [{ source: 'src/main.ts', target: 'src/shared.ts', specifier: './shared', line: 1 }],
  excludedGenerated: ['generated/schema.gen.ts'],
  binaryPaths: ['assets/logo.bin'],
  submodulePaths: ['vendor/widget'],
} as const;

export type GitHistoryFixture = {
  directory: string;
  refs: { root: string; featureAFirst: string; featureA: string; featureB: string; merge: string; widgetRoot: string; widgetUpdate: string };
  golden: typeof HISTORY_GOLDEN;
};

/**
 * Creates a fresh synthetic repository inside an EMPTY directory chosen by the caller.
 * Dates/identity/line endings/object format are fixed. Hooks, signing and user config are disabled.
 */
export function createGitHistoryFixture(directory: string): GitHistoryFixture {
  const repositoryDirectory = resolve(directory);
  mkdirSync(repositoryDirectory, { recursive: true });
  if (readdirSync(repositoryDirectory).length !== 0) throw new Error('Git fixture requires an empty directory');
  const environment: NodeJS.ProcessEnv = { ...process.env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_AUTHOR_NAME: 'Constellation Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Constellation Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };
  // Explicitly remove Git variables inherited from a surrounding checkout or hook.
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE'].includes(key)) delete environment[key];
  }
  const git = (args: string[], input?: string) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', `core.hooksPath=${resolve(repositoryDirectory, '.git/disabled-hooks')}`, '-c', 'commit.gpgsign=false', ...args], { cwd: repositoryDirectory, env: environment, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const put = (path: string, content: string | Uint8Array) => {
    mkdirSync(resolve(repositoryDirectory, path, '..'), { recursive: true });
    writeFileSync(resolve(repositoryDirectory, path), content);
  };
  const commit = (message: string) => { git(['commit', '-m', message]); return git(['rev-parse', 'HEAD']); };
  git(['init', '--object-format=sha1', '--initial-branch=main', '.']);
  const emptyTree = git(['hash-object', '-t', 'tree', '--stdin'], '');
  const widgetRoot = git(['commit-tree', emptyTree, '-m', 'Synthetic widget root']);
  const widgetUpdate = git(['commit-tree', emptyTree, '-p', widgetRoot, '-m', 'Synthetic widget update']);
  put('.gitmodules', '[submodule "widget"]\n\tpath = vendor/widget\n\turl = https://example.invalid/synthetic/widget.git\n');
  put('src/main.ts', "import { shared } from './shared';\nimport './missing';\nexport const main = shared;\n");
  put('src/shared.ts', "export const shared = 'root';\n");
  put('src/legacy.ts', 'export const legacy = true;\n');
  put('src/deleted.ts', 'export const removed = true;\n');
  put('generated/schema.gen.ts', '// Generated fixture; excluded from semantic analysis.\nexport const schema = 1;\n');
  put('assets/logo.bin', new Uint8Array([0, 1, 2, 255]));
  mkdirSync(resolve(repositoryDirectory, 'vendor/widget'), { recursive: true });
  git(['add', '--all']);
  git(['update-index', '--add', '--cacheinfo', `160000,${widgetRoot},vendor/widget`]);
  const root = commit('Root inventory with unresolved import and gitlink');

  git(['checkout', '-b', 'feature-a', root]);
  put('src/shared.ts', "export const shared = 'alpha-first';\n");
  git(['add', 'src/shared.ts']);
  const featureAFirst = commit('First edit in PR A');
  put('src/shared.ts', "export const shared = 'alpha-final';\n");
  put('src/auth.ts', "import { shared } from './shared';\nexport const auth = shared;\n");
  renameSync(resolve(repositoryDirectory, 'src/legacy.ts'), resolve(repositoryDirectory, 'src/renamed.ts'));
  rmSync(resolve(repositoryDirectory, 'src/deleted.ts'));
  put('generated/schema.gen.ts', '// Generated fixture; excluded from semantic analysis.\nexport const schema = 2;\n');
  put('assets/logo.bin', new Uint8Array([0, 3, 4, 255]));
  git(['add', '--all']);
  git(['update-index', '--cacheinfo', `160000,${widgetUpdate},vendor/widget`]);
  const featureA = commit('PR A add rename delete binary generated and submodule update');

  git(['checkout', '-b', 'feature-b', root]);
  put('src/shared.ts', "export const shared = 'billing';\n");
  put('src/billing.ts', "import { shared } from './shared';\nexport const billing = shared;\n");
  git(['add', '--all']);
  // Preserve the gitlink even though no submodule is initialized or contacted.
  git(['update-index', '--cacheinfo', `160000,${widgetRoot},vendor/widget`]);
  const featureB = commit('PR B independently edits shared file and adds billing');

  git(['checkout', 'main']);
  git(['merge', '--no-ff', '--no-edit', 'feature-a', '-m', 'Merge PR A using first-parent semantics']);
  const merge = git(['rev-parse', 'HEAD']);
  return { directory: repositoryDirectory, refs: { root, featureAFirst, featureA, featureB, merge, widgetRoot, widgetUpdate }, golden: HISTORY_GOLDEN };
}
