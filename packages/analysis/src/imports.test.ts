import { beforeEach, describe, expect, it } from 'vitest';
import { clearImportCacheForTests, extractImports, resolveImport, scanImports } from './imports';

beforeEach(clearImportCacheForTests);
describe('syntax-only extraction and package resolution', () => {
  it('extracts barrels, type syntax, commonjs, literal dynamic imports and reports computed imports', () => {
    const scan = scanImports([
      "import { type Foo } from './types';",
      "export { type Foo } from './types';",
      "export * from './barrel';",
      "import Foo = require('./common');",
      "const lazy = import(`./lazy`);",
      "type Other = import('./other').Other;",
      'import(`./${name}`);',
      "const runtime = require('./runtime');",
    ].join('\n'), 'app.ts');
    expect(scan.references.map(item => [item.specifier, item.kind, item.line])).toEqual([
      ['./types', 'type-import', 1], ['./types', 'type-import', 2], ['./barrel', 'reexport', 3],
      ['./common', 'import', 4], ['./lazy', 'dynamic-import', 5], ['./other', 'type-import', 6], ['./runtime', 'import', 8],
    ]);
    expect(scan.reasons).toEqual(['Non-literal dynamic-import at line 7 cannot be resolved statically.']);
  });
  it('reports malformed syntax instead of presenting complete parser coverage', () => {
    expect(scanImports("import { from './x';", 'broken.ts').reasons.join(' ')).toContain('Syntax error');
  });
  it('does not invent dependencies from a locally bound require function', () => {
    const scan = scanImports("function run(require: (x:string)=>string) { require('./not-a-module'); }", 'app.ts');
    expect(scan.references).toEqual([]);
    expect(scan.reasons.join(' ')).toContain('Locally bound require');
  });
  it('isolates cached syntax by content and returns independent values', () => {
    const first = scanImports("import './a';", 'app.ts', 'same-blob-fixture');
    first.references[0]!.specifier = 'tampered';
    expect(scanImports("import './a';", 'app.ts', 'same-blob-fixture').references[0]!.specifier).toBe('./a');
    expect(scanImports("import './b';", 'app.ts', 'same-blob-fixture').references[0]!.specifier).toBe('./b');
    expect(extractImports("// import './fake'\nconst s = `require('fake')`;", 'app.ts')).toEqual([]);
  });
  it('resolves extension substitutions and most-specific aliases', () => {
    const paths = new Set(['src/main.ts', 'src/specific/value.ts', 'src/general/value.ts', 'src/module.mts', 'src/common.cts']);
    expect(resolveImport('src/main.ts', '@pkg/value', paths, { aliases: { '@*': ['src/general/*'], '@pkg/*': ['src/specific/*'] } })).toBe('src/specific/value.ts');
    expect(resolveImport('src/main.ts', './module.mjs', paths)).toBe('src/module.mts');
    expect(resolveImport('src/main.ts', './common.cjs', paths)).toBe('src/common.cts');
    expect(resolveImport('src/main.ts', '../../outside', paths)).toBeNull();
  });
  it('preserves relative directory, JS suffix and legacy workspace entry resolution', () => {
    const paths = new Set(['src/auth/index.ts', 'src/shared/types.ts', 'packages/core/src/index.ts']);
    expect(resolveImport('src/app.ts', './auth', paths)).toBe('src/auth/index.ts');
    expect(resolveImport('src/app.ts', './shared/types.js', paths)).toBe('src/shared/types.ts');
    expect(resolveImport('src/app.ts', '@shared/types', paths, { aliases: { '@shared/*': ['src/shared/*'] } })).toBe('src/shared/types.ts');
    expect(resolveImport('src/app.ts', '@tool/core', paths, { workspacePackages: { '@tool/core': 'packages/core/src/index.ts' } })).toBe('packages/core/src/index.ts');
    expect(resolveImport('src/app.ts', 'react', paths)).toBeNull();
    expect(resolveImport('src/app.ts', './missing', paths)).toBeNull();
  });
  it('honors workspace exports, blocks private subpaths and does not escape package roots', () => {
    const paths = new Set(['packages/lib/src/index.ts', 'packages/lib/src/feature.ts', 'packages/lib/src/private.ts', 'packages/lib/src/a.ts', 'secret.ts']);
    const options = { workspacePackages: { '@acme/lib': { directory: 'packages/lib', entry: 'packages/lib/src/index.ts', exports: { '.': { types: './src/index.ts', default: './dist/index.js' }, './feature': './src/feature.ts', './items/*': './src/*.ts', './blocked': null, './escape': './../../secret.ts' } } } };
    expect(resolveImport('app/main.ts', '@acme/lib', paths, options)).toBe('packages/lib/src/index.ts');
    expect(resolveImport('app/main.ts', '@acme/lib/feature', paths, options)).toBe('packages/lib/src/feature.ts');
    expect(resolveImport('app/main.ts', '@acme/lib/items/a', paths, options)).toBe('packages/lib/src/a.ts');
    for (const path of ['private', 'blocked', 'escape']) expect(resolveImport('app/main.ts', `@acme/lib/${path}`, paths, options)).toBeNull();
  });
  it('resolves import and require export conditions independently', () => {
    const paths = new Set(['lib/esm.mts', 'lib/cjs.cts']);
    const workspacePackages = { lib: { directory: 'lib', entry: 'lib/esm.mts', exports: { import: './esm.mjs', require: './cjs.cjs' } } };
    expect(resolveImport('app.ts', 'lib', paths, { workspacePackages })).toBe('lib/esm.mts');
    expect(resolveImport('app.ts', 'lib', paths, { workspacePackages, resolutionMode: 'require' })).toBe('lib/cjs.cts');
  });
});
