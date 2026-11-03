export class BusyError extends Error {
  readonly status = 429;
  readonly code = 'BUSY';
  readonly retryAfter = 1;
  constructor() { super('Two analyses are already active. Wait a moment or cancel one, then retry.'); }
}

/** Reserve synchronously before persistence, queueing, or worker creation. No waiting queue. */
export class WorkerAdmission {
  private active = 0;
  constructor(private readonly limit = 2) {}
  reserve(): () => void {
    if (this.active >= this.limit) throw new BusyError();
    this.active++;
    let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }
}
