/** How an island came to exist, in words. */
const ORIGIN_PHRASES: Readonly<Record<string, string>> = Object.freeze({
  rules: 'Grouped by folder rule', manual: 'Your grouping', ai: 'AI grouping', manifest: 'Package manifest',
});
const squash = (value: string) => value.toLowerCase().replace(/[-_\s]+/g, '');

/**
 * The island tooltip's second line: where the island lives and how it was grouped.
 * A folder path whose last segments only repeat the island name is shortened to the
 * folder that holds it ("in src/"), or left out at the root.
 */
export function islandTipMeta(group: { label: string; path?: unknown; origin?: unknown }): string {
  let where = '';
  if (typeof group.path === 'string' && group.path) {
    const parts = group.path.split('/'), label = squash(group.label);
    const repeated = parts.findIndex((_, index) => squash(parts.slice(index).join('')) === label);
    where = repeated === -1 ? group.path : repeated > 0 ? `in ${parts.slice(0, repeated).join('/')}/` : '';
  }
  const origin = typeof group.origin === 'string' ? ORIGIN_PHRASES[group.origin] ?? '' : '';
  return [where, origin].filter(Boolean).join(' · ');
}
