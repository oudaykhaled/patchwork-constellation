import { describe, expect, it } from 'vitest';
import { applyHierarchy, deriveRepositoryHierarchy, nodeForPath, RepositoryMappingSchema } from './groups';

const monorepo = ['package.json', 'README.md', 'apps/web/package.json', 'apps/web/src/app.ts', 'packages/tiny/package.json', 'packages/tiny/index.ts', 'packages/core/package.json', 'packages/core/src/deep/nested/file.ts', 'packages/core/plugins/internal/package.json', 'packages/core/plugins/internal/index.ts'];
const manifests = [{ path: 'package.json', name: '@acme/root' }, { path: 'apps/web/package.json', name: '@acme/web' }, { path: 'packages/tiny/package.json', name: '@acme/tiny' }, { path: 'packages/core/package.json', name: '@acme/core' }, { path: 'packages/core/plugins/internal/package.json', name: '@acme/internal' }];
const primary = (paths: string[], options = {}) => Object.fromEntries(deriveRepositoryHierarchy(paths, options).memberships.map(item => [item.path, item.groupId]));

describe('deterministic repository hierarchy', () => {
  it('uses nearest declared monorepo packages, preserving even tiny package boundaries', () => {
    const hierarchy = deriveRepositoryHierarchy(monorepo, { manifests });
    expect(primary(monorepo, { manifests })).toEqual({
      'README.md': 'group:repository', 'apps/web/package.json': 'group:apps/web', 'apps/web/src/app.ts': 'group:apps/web', 'package.json': 'group:repository',
      'packages/core/package.json': 'group:packages/core', 'packages/core/plugins/internal/index.ts': 'group:packages/core/plugins/internal', 'packages/core/plugins/internal/package.json': 'group:packages/core/plugins/internal',
      'packages/core/src/deep/nested/file.ts': 'group:packages/core', 'packages/tiny/index.ts': 'group:packages/tiny', 'packages/tiny/package.json': 'group:packages/tiny',
    });
    expect(hierarchy.groups.find(group => group.id === 'group:packages/tiny')).toMatchObject({ label: '@acme/tiny', fileCount: 2, origin: 'manifest', evidence: [{ kind: 'manifest', path: 'packages/tiny/package.json', rule: 'nearest-package-boundary' }] });
    expect(hierarchy.groups.reduce((total, group) => total + Number(group.fileCount), 0)).toBe(monorepo.length);
    expect(hierarchy.folders.find(folder => folder.id === 'folder:.')).toMatchObject({ descendantFileCount: monorepo.length, directFileCount: 2 });
    expect(hierarchy.folders.find(folder => folder.path === 'packages/core/src/deep/nested')).toMatchObject({ parentId: 'folder:packages/core/src/deep', directFileCount: 1, descendantFileCount: 1 });
  });

  it('retains full deep folders while folding single-package files by declared path rules', () => {
    const paths = ['package.json', 'src/auth/deep/a.ts', 'src/auth/b.ts', 'src/api/c.ts'];
    const hierarchy = deriveRepositoryHierarchy(paths, { manifests: [{ path: 'package.json', name: 'single' }] });
    expect(primary(paths)).toEqual({ 'package.json': 'group:repository', 'src/api/c.ts': 'group:src/api', 'src/auth/b.ts': 'group:src/auth', 'src/auth/deep/a.ts': 'group:src/auth' });
    expect(hierarchy.memberships.find(item => item.path === 'src/auth/deep/a.ts')).toMatchObject({ folderId: 'folder:src/auth/deep' });
    expect(hierarchy.groups.find(group => group.id === 'group:src/auth')).toMatchObject({ origin: 'rules', evidence: [{ kind: 'path-rule', path: 'src/auth', rule: 'first-module-directory' }] });
    expect(hierarchy.groups.find(group => group.id === 'group:repository')?.label).toBe('single');
  });

  it('applies versioned explicit mappings before manifests and supports cross-cutting components', () => {
    const mapping = { version: 1, modules: [{ id: 'identity', label: 'Identity', paths: ['apps/web/src', 'packages/core/src'] }], components: [{ id: 'platform', label: 'Platform', moduleIds: ['identity'], paths: ['packages/tiny'] }], ungroupedPaths: ['packages/core/plugins'] };
    const hierarchy = deriveRepositoryHierarchy(monorepo, { manifests, mapping });
    expect(hierarchy.mappingVersion).toBe(1);
    expect(hierarchy.memberships.find(item => item.path === 'apps/web/src/app.ts')).toMatchObject({ groupId: 'group:user:identity', componentIds: ['component:user:platform'] });
    expect(hierarchy.memberships.find(item => item.path === 'packages/tiny/index.ts')).toMatchObject({ groupId: 'group:packages/tiny', componentIds: ['component:user:platform'] });
    expect(hierarchy.memberships.find(item => item.path === 'packages/core/plugins/internal/index.ts')?.groupId).toBe('group:system:ungrouped');
    expect(hierarchy.components).toEqual([{ id: 'component:user:platform', label: 'Platform', moduleIds: ['group:packages/tiny', 'group:user:identity'], filePaths: ['apps/web/src/app.ts', 'packages/core/src/deep/nested/file.ts', 'packages/tiny/index.ts', 'packages/tiny/package.json'], origin: 'manual', evidence: [{ kind: 'repository-mapping', path: '.constellation.json', rule: 'components.platform' }] }]);
    // Removing a mapping reverses its presentation without deleting/renaming physical folders.
    const baseline = deriveRepositoryHierarchy(monorepo, { manifests });
    expect(hierarchy.folders).toEqual(baseline.folders);
    expect(primary(monorepo, { manifests })['apps/web/src/app.ts']).toBe('group:apps/web');
  });

  it('keeps ignored content visible in explicitly ungrouped fallback rather than silently dropping it', () => {
    const paths = ['src/main.ts', 'vendor/code.c', 'node_modules/lib/index.js'];
    const hierarchy = deriveRepositoryHierarchy(paths, { mapping: { version: 1, ungroupedPaths: ['vendor', 'node_modules'] } });
    expect(hierarchy.memberships).toHaveLength(3);
    expect(hierarchy.groups.find(group => group.id === 'group:system:ungrouped')?.fileCount).toBe(2);
    expect(hierarchy.folders.find(folder => folder.path === 'node_modules/lib')?.directFileCount).toBe(1);
  });

  it('is byte-stable under ingestion, manifest, mapping and source-selection reorder', () => {
    const mapping = { version: 1, modules: [{ id: 'web', label: 'Web', paths: ['apps/web'] }, { id: 'core', label: 'Core', paths: ['packages/core'] }], components: [{ id: 'shared', label: 'Shared', moduleIds: ['web', 'core'] }] };
    const forward = deriveRepositoryHierarchy(monorepo, { manifests, mapping });
    const reverse = deriveRepositoryHierarchy([...monorepo].reverse(), { manifests: [...manifests].reverse(), mapping: { ...mapping, modules: [...mapping.modules].reverse() } });
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
    const oldGroup = forward.groups.find(group => group.id === 'group:packages/tiny');
    const extended = deriveRepositoryHierarchy([...monorepo, 'aaa/new.ts'], { manifests, mapping });
    expect(extended.groups.find(group => group.id === oldGroup?.id)?.color).toBe(oldGroup?.color);
    const nodes = monorepo.map(path => nodeForPath('acme/tool', path));
    expect(applyHierarchy(nodes, forward).map(node => node.groupId)).toEqual(applyHierarchy(nodes.map(node => ({ ...node, sourceIds: ['pr:2', 'pr:1'] })), forward).map(node => node.groupId));
    expect(nodes.every(node => node.groupId.startsWith('group:'))).toBe(true);
  });

  it('fails closed for ambiguous or unversioned mappings and unsafe paths', () => {
    expect(() => RepositoryMappingSchema.parse({ modules: [] })).toThrow();
    expect(() => RepositoryMappingSchema.parse({ version: 2 })).toThrow();
    expect(() => RepositoryMappingSchema.parse({ version: 1, modules: [{ id: 'x', label: 'X', paths: ['../secrets'] }] })).toThrow();
    expect(() => RepositoryMappingSchema.parse({ version: 1, components: [{ id: 'x', label: 'X', moduleIds: ['missing'] }] })).toThrow();
    expect(() => deriveRepositoryHierarchy(['src/a.ts'], { mapping: { version: 1, modules: [{ id: 'a', label: 'A', paths: ['src'] }, { id: 'b', label: 'B', paths: ['src'] }] } })).toThrow('Conflicting explicit module mappings');
    expect(() => deriveRepositoryHierarchy(['../a.ts'])).toThrow('Invalid repository path');
    expect(() => applyHierarchy([nodeForPath('acme/tool', 'missing.ts')], deriveRepositoryHierarchy(['src/a.ts']))).toThrow('Missing primary membership');
  });

  it('treats absent manifests and absent mapped paths as explicit warnings', () => {
    const hierarchy = deriveRepositoryHierarchy(['src/a.ts'], { manifests: [{ path: 'packages/lost/package.json', name: 'lost' }], mapping: { version: 1, modules: [{ id: 'lost', label: 'Lost', paths: ['absent'] }] } });
    expect(hierarchy.warnings).toEqual(['Ignored unavailable manifest boundary packages/lost/package.json.', 'Mapped path absent has no visible files.']);
    expect(hierarchy.groups.map(group => group.id)).toEqual(['group:src']);
  });

  it('keeps root and explicit fallback sentinels separate from real similarly named directories', () => {
    const paths = ['README.md', 'repository/package.json', 'repository/a.ts', 'ungrouped/a.ts', 'vendor/a.ts'];
    const hierarchy = deriveRepositoryHierarchy(paths, { manifests: [{ path: 'repository/package.json', name: 'storage' }], mapping: { version: 1, ungroupedPaths: ['vendor'] } });
    expect(hierarchy.groups).toHaveLength(4);
    expect(hierarchy.groups.find(group => group.id === 'group:repository')?.fileCount).toBe(1);
    expect(hierarchy.groups.find(group => group.id === 'group:path:repository')).toMatchObject({ label: 'storage', fileCount: 2 });
    expect(hierarchy.groups.find(group => group.id === 'group:system:ungrouped')?.fileCount).toBe(1);
    expect(hierarchy.groups.find(group => group.id === 'group:ungrouped')?.fileCount).toBe(1);
  });
});

