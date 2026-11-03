import { expect, test } from 'vitest';
import { RepositoryFences } from './repository-fences';
test('purge immediately rejects old work and deletes after an already-started asynchronous write', async () => {
  const fences = new RepositoryFences(), scope = { ownerId: 'github:alice', repository: 'acme/private' }, epoch = fences.capture(scope);
  const order: string[] = []; let release!: () => void, began!: () => void;
  const ready = new Promise<void>(resolve => { began = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const writing = fences.write(scope, epoch, async () => { order.push('write-start'); began(); await gate; order.push('write-end'); });
  await ready;
  const purging = fences.purge(scope, async () => { order.push('delete'); });
  expect(() => fences.assert(scope, epoch)).toThrow(); expect(() => fences.capture(scope)).toThrow();
  await expect(fences.write(scope, epoch, async () => { order.push('late-write'); })).rejects.toThrow();
  release(); await writing; await purging;
  expect(order).toEqual(['write-start', 'write-end', 'delete']); expect(fences.capture(scope)).toBe(epoch + 1);
  await expect(fences.write(scope, epoch, async () => {})).rejects.toThrow();
});
