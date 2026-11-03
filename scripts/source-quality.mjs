import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Deliberately small, stable rules: whitespace formatting and unsafe/debug code.
// TypeScript performs the full syntax/type check separately. No repository code is run.
export function formatSource(source, markdown = false) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  return lines.map(line => markdown ? line.replace(/\t+$/g, '') : line.replace(/[\t ]+$/g, '')).join('\n').replace(/\n*$/, '\n');
}

export function lintSource(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const failures = [];
  const report = (node, rule) => failures.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, rule });
  function visit(node) {
    if (ts.isDebuggerStatement(node)) report(node, 'no-debugger');
    if (ts.isWithStatement(node)) report(node, 'no-with');
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'eval') report(node, 'no-eval');
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'Function') report(node, 'no-new-function');
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'only') {
      let target = node.expression.expression;
      while (ts.isPropertyAccessExpression(target)) target = target.expression;
      if (ts.isIdentifier(target) && ['test', 'it', 'describe'].includes(target.text)) report(node, 'no-focused-tests');
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return failures;
}

export function checkFiles(paths, mode, fix = false) {
  const failures = [];
  for (const path of paths) {
    if (!/\.(?:[cm]?[jt]sx?|json|css|md|ya?ml)$/.test(path)) continue;
    const source = readFileSync(path, 'utf8');
    if (mode === 'format') {
      const formatted = formatSource(source, path.endsWith('.md'));
      // Accept a consistently CRLF working checkout, while producing LF on --fix.
      if (formatted !== source.replace(/\r\n/g, '\n')) {
        if (fix) writeFileSync(path, formatted);
        else failures.push({ path, rule: 'whitespace-format' });
      }
    } else if (/\.[cm]?[jt]sx?$/.test(path)) {
      failures.push(...lintSource(path, source).map(failure => ({ path, ...failure })));
    }
  }
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv.includes('--format') ? 'format' : 'lint';
  const paths = process.argv.slice(2).filter(value => !value.startsWith('--'));
  const tracked = paths.length ? paths : execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const failures = checkFiles(tracked, mode, process.argv.includes('--fix'));
  for (const { path, line, rule } of failures.slice(0, 100)) console.error(`${path}${line ? `:${line}` : ''}: ${rule}`);
  console.log(`${mode}: ${tracked.length} files inspected; ${failures.length} violations`);
  process.exitCode = failures.length ? 1 : 0;
}
