import ts from 'typescript';
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import type { ImportEdge } from '@patchwork/contracts';

export const RESOLVER_VERSION = 'typescript-static-exports-v3';
export interface ImportReference { specifier: string; line: number; kind: ImportEdge['kind']; resolutionMode?: 'import' | 'require'; }
export interface ImportScan { references: ImportReference[]; reasons: string[]; }
export interface WorkspacePackage { directory: string; entry: string; exports?: unknown; }
export interface ResolverOptions { aliases?: Record<string, string[]>; workspacePackages?: Record<string, string | WorkspacePackage>; resolutionMode?: 'import' | 'require'; coverageReasons?: string[]; }
const parseCache = new Map<string, ImportScan>();
const MAX_PARSE_CACHE = 500;

/** Cache syntax facts only. Resolution is rerun against each snapshot's paths and config. */
export function scanImports(content: string, path: string, blobSha = ''): ImportScan {
  const scriptKind = /\.tsx$/i.test(path) ? ts.ScriptKind.TSX : /\.jsx$/i.test(path) ? ts.ScriptKind.JSX : /\.[cm]?js$/i.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const key = `${RESOLVER_VERSION}:${ts.version}:${scriptKind}:${blobSha}:${createHash('sha256').update(content).digest('hex')}`;
  const cached = parseCache.get(key);
  if (cached) return structuredClone(cached);
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKind);
  const references: ImportReference[] = []; const reasons: string[] = [];
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  for (const diagnostic of diagnostics.slice(0, 8)) reasons.push(`Syntax error at line ${source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
  let requireShadowed = false;
  const declaresRequire = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isImportClause(node) || ts.isImportSpecifier(node)) && node.name && ts.isIdentifier(node.name) && node.name.text === 'require') requireShadowed = true;
    ts.forEachChild(node, declaresRequire);
  };
  declaresRequire(source);
  const add = (node: ts.Node, literal: ts.Expression | undefined, kind: ImportEdge['kind'], resolutionMode?: 'require') => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    if (resolutionMode && requireShadowed) { reasons.push(`Locally bound require at line ${line} is not assumed to be a module import.`); return; }
    if (literal && (ts.isStringLiteralLike(literal) || ts.isNoSubstitutionTemplateLiteral(literal))) references.push({ specifier: literal.text, line, kind, ...(resolutionMode ? { resolutionMode } : {}) });
    else reasons.push(`Non-literal ${kind} at line ${line} cannot be resolved statically.`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const allType = clause?.isTypeOnly || (!clause?.name && clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(item => item.isTypeOnly));
      add(node, node.moduleSpecifier, allType ? 'type-import' : 'import');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const allType = node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(item => item.isTypeOnly));
      add(node, node.moduleSpecifier, allType ? 'type-import' : 'reexport');
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node, node.moduleReference.expression, 'import', 'require');
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node, node.argument.literal as ts.Expression, 'type-import');
    else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0], 'dynamic-import');
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node, node.arguments[0], 'import', 'require');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const result = { references, reasons };
  if (parseCache.size >= MAX_PARSE_CACHE) parseCache.delete(parseCache.keys().next().value!);
  parseCache.set(key, structuredClone(result));
  return result;
}
export function extractImports(content: string, path: string): ImportReference[] { return scanImports(content, path).references; }
export function clearImportCacheForTests() { parseCache.clear(); }

const extensions = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.mts', '/index.cts', '/index.js', '/index.jsx', '/index.mjs', '/index.cjs'];
const safePath = (value: string) => !value.startsWith('/') && !value.startsWith('../') && value !== '..' && !/[\\\0]/.test(value);
function matchPattern(pattern: string, value: string): string | null {
  const star = pattern.indexOf('*');
  if (star < 0) return pattern === value ? '' : null;
  const before = pattern.slice(0, star), after = pattern.slice(star + 1);
  return value.startsWith(before) && value.endsWith(after) && value.length >= before.length + after.length ? value.slice(before.length, value.length - after.length) : null;
}
/** Static ESM/type condition order. Unknown conditions are not guessed. */
function exportTargets(value: unknown, mode: 'import' | 'require'): string[] {
  if (typeof value === 'string') return [value];
  if (value === null) return [];
  if (Array.isArray(value)) return value.flatMap(item => exportTargets(item, mode));
  if (value && typeof value === 'object') {
    for (const [condition, target] of Object.entries(value)) if (['types', mode, 'node', 'default'].includes(condition)) { const targets = exportTargets(target, mode); if (targets.length) return targets; }
  }
  return [];
}
function packageCandidates(pkg: WorkspacePackage, subpath: string, mode: 'import' | 'require'): string[] {
  if (pkg.exports === undefined) return [subpath === '.' ? pkg.entry : posix.join(pkg.directory, subpath.slice(2))];
  let target: unknown = pkg.exports; let wildcard = '';
  if (target && typeof target === 'object' && !Array.isArray(target) && Object.keys(target).some(key => key.startsWith('.'))) {
    if (Object.keys(target).some(key => !key.startsWith('.'))) return []; // Invalid mixed condition/subpath map.
    const entries = Object.entries(target).sort(([a], [b]) => Number(b === subpath) - Number(a === subpath) || b.replace('*', '').length - a.replace('*', '').length || a.localeCompare(b));
    const match = entries.find(([pattern]) => matchPattern(pattern, subpath) !== null);
    if (!match) return [];
    wildcard = matchPattern(match[0], subpath)!; target = match[1];
  } else if (subpath !== '.') return [];
  return exportTargets(target, mode).flatMap(value => {
    const replaced = value.replaceAll('*', wildcard);
    if (!replaced.startsWith('./') || replaced.split('/').some(part => part === '..' || part === 'node_modules')) return [];
    const candidate = posix.normalize(posix.join(pkg.directory, replaced));
    return safePath(candidate) ? [candidate] : [];
  });
}
export function resolveImport(from: string, specifier: string, paths: Set<string>, options: ResolverOptions = {}): string | null {
  if (!specifier || /[\0\\?#]/.test(specifier)) return null;
  const candidates: string[] = [];
  if (specifier.startsWith('.')) candidates.push(posix.normalize(posix.join(posix.dirname(from), specifier)));
  else {
    const aliases = Object.entries(options.aliases ?? {}).sort(([a], [b]) => Number(b === specifier) - Number(a === specifier) || b.split('*')[0]!.length - a.split('*')[0]!.length);
    for (const [alias, replacements] of aliases) {
      const middle = matchPattern(alias, specifier);
      if (middle !== null) { candidates.push(...replacements.map(path => path.replace('*', middle))); break; }
    }
    for (const [name, entry] of Object.entries(options.workspacePackages ?? {}).sort(([a], [b]) => b.length - a.length)) {
      if (specifier === name || specifier.startsWith(`${name}/`)) {
        const pkg = typeof entry === 'string' ? { directory: posix.dirname(entry), entry } : entry;
        candidates.push(...packageCandidates(pkg, specifier === name ? '.' : `./${specifier.slice(name.length + 1)}`, options.resolutionMode ?? 'import')); break;
      }
    }
  }
  for (let candidate of candidates) {
    candidate = posix.normalize(candidate).replace(/^\.\//, '');
    if (!safePath(candidate)) continue;
    const replacements = /\.mjs$/.test(candidate) ? [candidate.replace(/\.mjs$/, '.mts'), candidate.replace(/\.mjs$/, '.d.mts'), candidate] : /\.cjs$/.test(candidate) ? [candidate.replace(/\.cjs$/, '.cts'), candidate.replace(/\.cjs$/, '.d.cts'), candidate] : /\.jsx?$/.test(candidate) ? ['.ts', '.tsx', '.d.ts', /\.jsx$/.test(candidate) ? '.jsx' : '.js'].map(suffix => candidate.replace(/\.jsx?$/, suffix)) : extensions.map(extension => candidate + extension);
    for (const path of replacements) if (paths.has(path)) return path;
  }
  return null;
}
export function importIsInternal(specifier: string, options: ResolverOptions = {}): boolean {
  return specifier.startsWith('.') || Object.keys(options.aliases ?? {}).some(alias => matchPattern(alias, specifier) !== null) || Object.keys(options.workspacePackages ?? {}).some(name => specifier === name || specifier.startsWith(`${name}/`));
}
export function isSourceFile(path: string) { return /\.[cm]?[jt]sx?$/i.test(path) && !/(^|\/)(node_modules|vendor|dist|build|coverage|\.git)(\/|$)/.test(path); }
export function languageFor(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  return ({ ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', json: 'JSON', md: 'Markdown', css: 'CSS', scss: 'SCSS', html: 'HTML', py: 'Python', go: 'Go', rs: 'Rust', kt: 'Kotlin', java: 'Java', yml: 'YAML', yaml: 'YAML', svg: 'SVG' } as Record<string, string>)[extension ?? ''] ?? 'Other';
}
