import type { StoreScope } from '@patchwork/storage';
const keyFor = (scope: StoreScope) => JSON.stringify([scope.ownerId, scope.repository.toLowerCase()]);
const unavailable = () => Object.assign(new Error('Repository access changed. Reconnect and analyze again.'), { status: 409, code: 'REPOSITORY_INVALIDATED' });
/** A purge advances its epoch immediately, then deletes after all older writes settle. */
export class RepositoryFences {
  private epochs = new Map<string, number>();
  private purging = new Set<string>();
  private writes = new Map<string, Promise<unknown>>();
  capture(scope: StoreScope) {
    const key = keyFor(scope); if (this.purging.has(key)) throw unavailable();
    if (!this.epochs.has(key)) { if (this.epochs.size >= 2_000) throw Object.assign(new Error('Repository session capacity reached. Restart the application.'), { status: 503, code: 'REPOSITORY_CAPACITY' }); this.epochs.set(key, 0); }
    return this.epochs.get(key)!;
  }
  assert(scope: StoreScope, epoch: number) { if (this.purging.has(keyFor(scope)) || this.epochs.get(keyFor(scope)) !== epoch) throw unavailable(); }
  async write<T>(scope: StoreScope, epoch: number, run: () => Promise<T>): Promise<T> {
    this.assert(scope, epoch); const key = keyFor(scope), previous = this.writes.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => { this.assert(scope, epoch); return run(); }); this.writes.set(key, next);
    try { return await next; } finally { if (this.writes.get(key) === next) this.writes.delete(key); }
  }
  async purge(scope: StoreScope, run: () => Promise<void>) {
    const key = keyFor(scope), epoch = (this.epochs.get(key) ?? 0) + 1;
    this.epochs.set(key, epoch); this.purging.add(key);
    const previous = this.writes.get(key) ?? Promise.resolve(), next = previous.catch(() => {}).then(run); this.writes.set(key, next);
    try { await next; } finally { if (this.writes.get(key) === next) this.writes.delete(key); if (this.epochs.get(key) === epoch) this.purging.delete(key); }
  }
}
