import { describe, expect, it } from 'vitest';
import { extractImports, resolveImport } from './imports';
import { deriveGroups } from './groups';
describe('static import evidence', () => {
  it('extracts typed imports, reexports, dynamic literals and require without comments', () => {
    const refs = extractImports(`// import fake from './secret'\nimport type { X } from './types';\nexport { a } from './a';\nconst x = import('./lazy');\nconst y = require('./cjs');\nconst z = import(variable);`, 'src/index.ts');
    expect(refs).toEqual([
      { specifier: './types', kind: 'type-import', line: 2 },
      { specifier: './a', kind: 'reexport', line: 3 },
      { specifier: './lazy', kind: 'dynamic-import', line: 4 },
      { specifier: './cjs', kind: 'import', line: 5 },
    ]);
  });
  it('resolves relative JS suffixes, tsconfig aliases and workspace entries', () => {
    const paths = new Set(['src/auth/index.ts', 'src/shared/types.ts', 'packages/core/src/index.ts']);
    expect(resolveImport('src/app.ts', './auth', paths)).toBe('src/auth/index.ts');
    expect(resolveImport('src/app.ts', './shared/types.js', paths)).toBe('src/shared/types.ts');
    expect(resolveImport('src/app.ts', '@shared/types', paths, { aliases: { '@shared/*': ['src/shared/*'] } })).toBe('src/shared/types.ts');
    expect(resolveImport('src/app.ts', '@tool/core', paths, { workspacePackages: { '@tool/core': 'packages/core/src/index.ts' } })).toBe('packages/core/src/index.ts');
    expect(resolveImport('src/app.ts', 'react', paths)).toBeNull();
    expect(resolveImport('src/app.ts', './missing', paths)).toBeNull();
  });
  it('derives stable identities and group order independent of ingest order', () => {
    const paths = ['src/auth/a.ts', 'packages/core/src/index.ts', 'README.md', 'src/api/client.ts'];
    expect(deriveGroups(paths)).toEqual(deriveGroups([...paths].reverse()));
    expect(deriveGroups(paths).map(group => group.id)).toEqual(['group:packages/core', 'group:repository', 'group:src/api', 'group:src/auth']);
  });
});
