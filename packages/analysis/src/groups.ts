import { createHash } from 'node:crypto';
import { z } from 'zod';
import { unparsedFileFacts, type FileNode, type Group } from '@patchwork/contracts';

// Eight identity hues kept apart on the map; the client moves greens away from the changed green.
export const GROUP_PALETTE: readonly string[] = ['#66bfa0', '#9d8fd4', '#6a9ec7', '#b8a073', '#b377c3', '#839da0', '#ae8ca1', '#98ac7a'];
export const GROUPING_RULES_VERSION = 'hierarchy-v1';
const ordered = (values: Iterable<string>) => [...new Set(values)].sort();
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);
const colorFor = (key: string) => GROUP_PALETTE[Number.parseInt(digest(key).slice(0, 8), 16) % GROUP_PALETTE.length]!;
const isRelativePath = (value: string) => value.length <= 1_024 && !/[:\\\x00-\x1f\x7f]/.test(value) && !value.startsWith('/') && !value.endsWith('/') && value.split('/').every(part => part !== '.' && part !== '..' && part !== '');
const RelativePath = z.string().refine(isRelativePath, 'Expected a normalized repository-relative path');
const Identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
const Label = z.string().trim().min(1).max(120);

/** Declarative paths only: no globs, expressions, scripts, remote URLs or imported configuration. */
export const RepositoryMappingSchema = z.object({
  version: z.literal(1),
  modules: z.array(z.object({ id: Identifier, label: Label, paths: z.array(RelativePath).min(1).max(1_000) }).strict()).max(200).default([]),
  components: z.array(z.object({ id: Identifier, label: Label, moduleIds: z.array(Identifier).max(200).default([]), paths: z.array(RelativePath).max(1_000).default([]) }).strict()).max(200).default([]),
  ungroupedPaths: z.array(RelativePath).max(200).default([]),
}).strict().superRefine((mapping, context) => {
  for (const key of ['modules', 'components'] as const) {
    const ids = new Set<string>();
    mapping[key].forEach((item, index) => {
      if (ids.has(item.id)) context.addIssue({ code: 'custom', path: [key, index, 'id'], message: 'Duplicate mapping ID' });
      ids.add(item.id);
    });
  }
  const modules = new Set(mapping.modules.map(item => item.id));
  mapping.components.forEach((component, index) => component.moduleIds.forEach(id => {
    if (!modules.has(id)) context.addIssue({ code: 'custom', path: ['components', index, 'moduleIds'], message: `Unknown mapped module: ${id}` });
  }));
});
export type RepositoryMapping = z.infer<typeof RepositoryMappingSchema>;
export interface ManifestBoundary { path: string; name?: string; }
export interface HierarchyEvidence { kind: 'path-rule' | 'manifest' | 'repository-mapping'; path: string; rule: string; }
export interface PhysicalFolder { id: string; path: string; parentId?: string; directFileCount: number; descendantFileCount: number; }
export interface ComponentMembership { id: string; label: string; moduleIds: string[]; filePaths: string[]; origin: 'manual'; evidence: HierarchyEvidence[]; }
export interface FileMembership { path: string; folderId: string; groupId: string; componentIds: string[]; }
export interface RepositoryHierarchy {
  schemaVersion: '1';
  rulesVersion: typeof GROUPING_RULES_VERSION;
  revision: string;
  mappingVersion?: 1;
  groups: Group[];
  folders: PhysicalFolder[];
  components: ComponentMembership[];
  memberships: FileMembership[];
  warnings: string[];
}
export interface HierarchyOptions { manifests?: ManifestBoundary[]; mapping?: unknown; }

export function groupKeyFor(path: string): string {
  const parts = path.split('/');
  if (parts.length === 1) return 'repository';
  // The root sentinel cannot collide with a real directory called repository.
  if (parts[0] === 'repository') return 'path:repository';
  if (['packages', 'apps', 'services', 'src', 'lib'].includes(parts[0]!) && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0]!;
}
export function groupLabel(key: string): string {
  if (key === 'repository') return 'Repository root';
  if (key === 'path:repository') return 'Repository';
  const name = key.split('/').pop()!;
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
const matches = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);
const folderFor = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const folderId = (path: string) => `folder:${path || '.'}`;

/**
 * A pure hierarchy of physical folders and semantic primary islands. No aggregate is a FileNode.
 * Package boundaries win over path heuristics; explicit mapping wins over both. Rules never merge
 * tiny packages by size. Deep path folding changes only primary-island presentation, not folders.
 */
export function deriveRepositoryHierarchy(inputPaths: string[], options: HierarchyOptions = {}): RepositoryHierarchy {
  const paths = ordered(inputPaths);
  for (const path of paths) if (!isRelativePath(path)) throw new Error(`Invalid repository path: ${JSON.stringify(path)}`);
  const warnings: string[] = [];
  const mapping = options.mapping === undefined ? undefined : RepositoryMappingSchema.parse(options.mapping);
  const modules = [...(mapping?.modules ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  const manifests = [...(options.manifests ?? [])].filter(item => {
    if (!isRelativePath(item.path) || !/(^|\/)package\.json$/.test(item.path) || !paths.includes(item.path)) { warnings.push(`Ignored unavailable manifest boundary ${item.path}.`); return false; }
    return true;
  }).sort((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
  const rootManifest = manifests.find(item => item.path === 'package.json');
  const groups = new Map<string, Group>();
  const memberships: FileMembership[] = [];
  for (const path of paths) {
    const candidates = modules.flatMap(module => module.paths.filter(prefix => matches(path, prefix)).map(prefix => ({ module, prefix })))
      .sort((a, b) => b.prefix.length - a.prefix.length || a.module.id.localeCompare(b.module.id));
    if (candidates[1] && candidates[0]!.prefix.length === candidates[1].prefix.length && candidates[0]!.module.id !== candidates[1].module.id) throw new Error(`Conflicting explicit module mappings for ${path}`);
    const explicit = candidates[0];
    const manifest = manifests.find(item => item.path !== 'package.json' && matches(path, folderFor(item.path)));
    const ungrouped = mapping?.ungroupedPaths.some(prefix => matches(path, prefix)) ?? false;
    let group: Group;
    if (explicit) {
      group = { id: `group:user:${explicit.module.id}`, label: explicit.module.label, component: 'Module', origin: 'manual', color: colorFor(`user:${explicit.module.id}`), evidence: ordered(explicit.module.paths).map(prefix => ({ kind: 'repository-mapping', path: '.constellation.json', rule: `modules.${explicit.module.id}: ${prefix}` } satisfies HierarchyEvidence)) };
    } else if (ungrouped) {
      group = { id: 'group:system:ungrouped', label: 'Ungrouped', component: 'Module', origin: 'manual', color: colorFor('ungrouped'), evidence: [{ kind: 'repository-mapping', path: '.constellation.json', rule: 'ungroupedPaths' }] satisfies HierarchyEvidence[] };
    } else if (manifest) {
      const directory = folderFor(manifest.path);
      group = { id: `group:${directory === 'repository' ? 'path:repository' : directory}`, label: manifest.name?.trim() || groupLabel(directory === 'repository' ? 'path:repository' : directory), component: 'Package', origin: 'manifest', color: colorFor(directory), path: directory, evidence: [{ kind: 'manifest', path: manifest.path, rule: 'nearest-package-boundary' }] satisfies HierarchyEvidence[] };
    } else {
      const key = groupKeyFor(path);
      const physicalPath = key === 'repository' ? '' : key === 'path:repository' ? 'repository' : key;
      group = { id: `group:${key}`, label: key === 'repository' && rootManifest?.name?.trim() ? rootManifest.name.trim() : groupLabel(key), component: key.startsWith('packages/') ? 'Package' : key.startsWith('apps/') ? 'Application' : 'Module', origin: key === 'repository' && rootManifest ? 'manifest' : 'rules', color: colorFor(key), path: physicalPath, evidence: [{ kind: key === 'repository' && rootManifest ? 'manifest' : 'path-rule', path: key === 'repository' && rootManifest ? rootManifest.path : physicalPath, rule: key === 'repository' ? 'repository-root' : 'first-module-directory' }] satisfies HierarchyEvidence[] };
    }
    groups.set(group.id, group);
    memberships.push({ path, folderId: folderId(folderFor(path)), groupId: group.id, componentIds: [] });
  }
  const components: ComponentMembership[] = [...(mapping?.components ?? [])].sort((a, b) => a.id.localeCompare(b.id)).map(component => {
    const memberGroups = new Set(component.moduleIds.map(id => `group:user:${id}`));
    const files = memberships.filter(item => memberGroups.has(item.groupId) || component.paths.some(prefix => matches(item.path, prefix)));
    const id = `component:user:${component.id}`;
    files.forEach(item => item.componentIds.push(id));
    return { id, label: component.label, moduleIds: ordered(files.map(item => item.groupId)), filePaths: files.map(item => item.path), origin: 'manual', evidence: [{ kind: 'repository-mapping', path: '.constellation.json', rule: `components.${component.id}` }] };
  });
  const folders = new Map<string, PhysicalFolder>();
  for (const path of paths) {
    const direct = folderFor(path);
    const segments = direct ? direct.split('/') : [];
    for (let depth = 0; depth <= segments.length; depth++) {
      const directory = segments.slice(0, depth).join('/');
      const id = folderId(directory);
      const folder = folders.get(id) ?? { id, path: directory, ...(directory ? { parentId: folderId(folderFor(directory)) } : {}), directFileCount: 0, descendantFileCount: 0 };
      folder.descendantFileCount++;
      if (directory === direct) folder.directFileCount++;
      folders.set(id, folder);
    }
  }
  const filesByGroup = new Map<string, FileMembership[]>();
  for (const item of memberships) {
    const files = filesByGroup.get(item.groupId) ?? [];
    files.push(item);
    filesByGroup.set(item.groupId, files);
  }
  for (const group of groups.values()) {
    const files = filesByGroup.get(group.id) ?? [];
    group.fileCount = files.length;
    group.folderIds = ordered(files.map(item => item.folderId));
    group.componentIds = ordered(files.flatMap(item => item.componentIds));
  }
  for (const module of modules) for (const prefix of module.paths) if (!paths.some(path => matches(path, prefix))) warnings.push(`Mapped path ${prefix} has no visible files.`);
  const result: Omit<RepositoryHierarchy, 'revision'> = { schemaVersion: '1', rulesVersion: GROUPING_RULES_VERSION, groups: [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)), folders: [...folders.values()].sort((a, b) => a.path.localeCompare(b.path)), components, memberships, warnings: ordered(warnings), ...(mapping ? { mappingVersion: 1 as const } : {}) };
  return { ...result, revision: `grouping:${digest(JSON.stringify(result))}` };
}

export function deriveGroups(paths: string[]): Group[] { return deriveRepositoryHierarchy(paths).groups; }
export function applyHierarchy(nodes: FileNode[], hierarchy: RepositoryHierarchy): FileNode[] {
  const memberships = new Map(hierarchy.memberships.map(item => [item.path, item]));
  return nodes.map(node => {
    const membership = memberships.get(node.path);
    if (!membership) throw new Error(`Missing primary membership for ${node.path}`);
    return { ...node, groupId: membership.groupId, folder: folderFor(node.path), folderId: membership.folderId, componentIds: membership.componentIds };
  });
}
export function nodeForPath(fullName: string, path: string): FileNode {
  return { ...unparsedFileFacts('Dependency extraction has not run for this context inventory entry.'), id: `${fullName}:${path}`, path, groupId: `group:${groupKeyFor(path)}`, sourceIds: [], folder: folderFor(path), folderId: folderId(folderFor(path)) };
}
