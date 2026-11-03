import ts from 'typescript';
import { posix } from 'node:path';
import type { ImportEdge } from '@patchwork/contracts';

export interface ImportReference { specifier: string; line: number; kind: ImportEdge['kind']; }
export interface ResolverOptions { aliases?: Record<string, string[]>; workspacePackages?: Record<string, string>; }
export function extractImports(content: string, path: string): ImportReference[] {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, /\.tsx$/i.test(path) ? ts.ScriptKind.TSX : /\.jsx$/i.test(path) ? ts.ScriptKind.JSX : /\.[cm]?js$/i.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const result: ImportReference[] = [];
  const add = (node: ts.Node, literal: ts.Expression | undefined, kind: ImportEdge['kind']) => {
    if (literal && ts.isStringLiteralLike(literal)) result.push({ specifier: literal.text, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, kind });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) add(node, node.moduleSpecifier, node.importClause?.isTypeOnly ? 'type-import' : 'import');
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node, node.moduleSpecifier, node.isTypeOnly ? 'type-import' : 'reexport');
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node, node.moduleReference.expression, 'import');
    else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, node.arguments[0], 'dynamic-import');
      else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node, node.arguments[0], 'import');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}
const extensions = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
export function resolveImport(from: string, specifier: string, paths: Set<string>, options: ResolverOptions = {}): string | null {
  const candidates: string[] = [];
  if (specifier.startsWith('.')) candidates.push(posix.normalize(posix.join(posix.dirname(from), specifier)));
  else {
    for (const [alias, replacements] of Object.entries(options.aliases ?? {})) {
      const star = alias.indexOf('*');
      if (star === -1 && alias === specifier) candidates.push(...replacements);
      else if (star >= 0 && specifier.startsWith(alias.slice(0, star)) && specifier.endsWith(alias.slice(star + 1))) {
        const middle = specifier.slice(star, specifier.length - (alias.length - star - 1));
        candidates.push(...replacements.map(p => p.replace('*', middle)));
      }
    }
    for (const [name, entry] of Object.entries(options.workspacePackages ?? {})) {
      if (specifier === name) candidates.push(entry);
      else if (specifier.startsWith(`${name}/`)) candidates.push(posix.join(posix.dirname(entry), specifier.slice(name.length + 1)));
    }
  }
  for (let candidate of candidates) {
    candidate = candidate.replace(/^\.\//, '');
    // TypeScript resolves JavaScript import suffixes to their source files.
    const bases = /\.[cm]?jsx?$/.test(candidate) ? [candidate, candidate.replace(/\.[cm]?jsx?$/, '')] : [candidate];
    for (const base of bases) for (const extension of extensions) if (paths.has(base + extension)) return base + extension;
  }
  return null;
}

export function isSourceFile(path: string) { return /\.[cm]?[jt]sx?$/i.test(path) && !/(^|\/)(node_modules|vendor|dist|build|coverage|\.git)(\/|$)/.test(path); }
export function languageFor(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  return ({ ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', json: 'JSON', md: 'Markdown', css: 'CSS', scss: 'SCSS', html: 'HTML', py: 'Python', go: 'Go', rs: 'Rust', kt: 'Kotlin', java: 'Java', yml: 'YAML', yaml: 'YAML', svg: 'SVG' } as Record<string, string>)[extension ?? ''] ?? 'Other';
}
