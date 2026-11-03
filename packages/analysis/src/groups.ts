import type { FileNode, Group } from '@patchwork/contracts';

const palette = ['#66bfa0', '#9d8fd4', '#6a9ec7', '#b8a073', '#7796c3', '#839da0', '#ae8ca1', '#98ac7a'];
export function groupKeyFor(path: string): string {
  const parts = path.split('/');
  if (parts.length === 1) return 'repository';
  if (['packages', 'apps', 'services', 'src', 'lib'].includes(parts[0]!) && parts.length > 2) return `${parts[0]}/${parts[1]}`;
  return parts[0]!;
}
export function groupLabel(key: string): string {
  if (key === 'repository') return 'Repository root';
  const name = key.split('/').pop()!;
  return name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
export function deriveGroups(paths: string[]): Group[] {
  return [...new Set(paths.map(groupKeyFor))].sort().map((key, index) => ({ id: `group:${key}`, label: groupLabel(key), component: key.startsWith('packages/') ? 'Package' : key.startsWith('apps/') ? 'Application' : 'Module', color: palette[index % palette.length], origin: 'rules' as const, path: key === 'repository' ? '' : key }));
}
export function nodeForPath(fullName: string, path: string): FileNode {
  return { id: `${fullName}:${path}`, path, groupId: `group:${groupKeyFor(path)}`, sourceIds: [], presence: 'context', status: 'unchanged', folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '' };
}
