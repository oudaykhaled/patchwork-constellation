import { execFileSync } from 'node:child_process';
import { createGitHistoryFixture, type GitHistoryFixture } from '../../packages/fixtures/src/git-history';

/** An authored local Git repository exposed through a read-only GitHub-shaped transport.
 * Expected sets remain the fixture author's declarations, independent of analysis code.
 */
export function gitCorpus(directory: string, options: { truncated?: boolean; extraPaths?: string[] } = {}) {
  const history = createGitHistoryFixture(directory);
  const calls: string[] = [];
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'core.autocrlf=false', ...args], { cwd: directory, encoding: 'utf8', windowsHide: true });
  const files = (base: string, head: string) => {
    const records = git('diff', '--no-ext-diff', '--no-textconv', '--find-renames=50%', '--name-status', '-z', base, head, '--').split('\0');
    const result: { filename: string; previous_filename?: string; status: string; additions: number; deletions: number }[] = [];
    for (let index = 0; index < records.length - 1;) {
      const kind = records[index++]!, first = records[index++]!;
      const renamed = kind.startsWith('R');
      result.push({ filename: renamed ? records[index++]! : first, ...(renamed ? { previous_filename: first } : {}), status: renamed ? 'renamed' : ({ A: 'added', M: 'modified', D: 'removed' } as Record<string, string>)[kind]!, additions: 0, deletions: 0 });
    }
    return result;
  };
  const parentShas = (sha: string) => git('show', '-s', '--format=%P', sha).trim().split(' ').filter(Boolean);
  const commit = (sha: string) => ({ sha, html_url: `https://github.com/fixture/corpus/commit/${sha}`, commit: { message: `Authored ${sha.slice(0, 7)}` }, parents: parentShas(sha).map(parent => ({ sha: parent })) });
  const pull = (number: number) => ({ number, title: `Authored PR ${number}`, html_url: `https://github.com/fixture/corpus/pull/${number}`, state: 'open', changed_files: number === 2 ? 2 : 7, base: { sha: history.refs.root, ref: 'main' }, head: { sha: number === 2 ? history.refs.featureB : history.refs.featureA, ref: number === 2 ? 'feature-b' : 'feature-a' } });
  const allPulls = Array.from({ length: 31 }, (_, index) => pull(index + 1));
  const tree = git('ls-tree', '-r', '-z', history.refs.root).split('\0').filter(Boolean).map(record => {
    const [metadata, path] = record.split('\t');
    const [mode, type, sha] = metadata!.split(' ');
    return { path: path!, mode: mode!, type: type!, sha: sha!, size: type === 'blob' ? Buffer.byteLength(git('show', `${history.refs.root}:${path}`)) : 0 };
  });
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(String(input)); calls.push(url.href);
    if (url.hostname === 'raw.githubusercontent.com') {
      const parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
      const sha = parts[2]!, path = parts.slice(3).join('/');
      // Only our authored history objects are accepted; no arbitrary process arguments.
      if (!Object.values(history.refs).includes(sha) || !tree.some(entry => entry.path === path)) return new Response('', { status: 404 });
      return new Response(git('show', `${sha}:${path}`));
    }
    if (url.hostname !== 'api.github.com') throw new Error('Unexpected transport destination');
    const path = url.pathname.replace('/repos/fixture/corpus', '');
    if (path === '') return Response.json({ name: 'corpus', full_name: 'fixture/corpus', private: false, default_branch: 'main', html_url: 'https://github.com/fixture/corpus', owner: { login: 'fixture' } });
    if (path === '/commits/main' || path === `/commits/${history.refs.root}`) return Response.json({ ...commit(history.refs.root), files: files('4b825dc642cb6eb9a060e54bf8d69288fbee4904', history.refs.root) });
    if (path.startsWith('/git/trees/')) return Response.json({ truncated: Boolean(options.truncated), tree: [...(options.truncated ? tree.slice(0, 4) : tree), ...(options.extraPaths ?? []).map(path => ({ path, type: 'blob', mode: '100644', sha: history.refs.root, size: 1 }))] });
    if (path === '/pulls') {
      const page = Number(url.searchParams.get('page') ?? 1), limit = Number(url.searchParams.get('per_page') ?? 30);
      const items = allPulls.slice((page - 1) * limit, page * limit);
      return Response.json(items, { headers: page * limit < allPulls.length ? { Link: `<https://api.github.com/repos/fixture/corpus/pulls?page=${page + 1}>; rel="next"` } : {} });
    }
    if (path === '/commits') return Response.json([commit(history.refs.root), commit(history.refs.merge)]);
    const pullMatch = /^\/pulls\/(\d+)(\/files)?$/.exec(path);
    if (pullMatch) { const value = pull(Number(pullMatch[1])); return Response.json(pullMatch[2] ? files(value.base.sha, value.head.sha) : value); }
    const comparison = /^\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/.exec(path);
    if (comparison) return Response.json({ merge_base_commit: { sha: comparison[1] }, files: files(comparison[1]!, comparison[2]!) });
    const commitMatch = /^\/commits\/([a-f0-9]{40})$/.exec(path);
    if (commitMatch && Object.values(history.refs).includes(commitMatch[1]!)) { const value = commit(commitMatch[1]!); return Response.json({ ...value, files: files(value.parents[0]?.sha ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904', value.sha) }); }
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return { history, fetch: fetcher, calls, files };
}

export function declaredChanges(history: GitHistoryFixture, kind: 'featureA' | 'featureB') {
  return history.golden[kind].map(change => ({ path: change.path, status: change.status.startsWith('R') ? 'renamed' : ({ A: 'added', M: 'modified', D: 'removed' } as Record<string, string>)[change.status], ...('previousPath' in change ? { previousPath: change.previousPath } : {}) })).sort((a, b) => a.path.localeCompare(b.path));
}
