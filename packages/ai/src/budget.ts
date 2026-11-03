import { GroupingError } from './types';

interface UsageWindow { usedRequests: number; reservedRequests: number; usedTokens: number; reservedTokens: number; reset: number }
/** Process-local reservation ledger. Multiple instances require a shared atomic store. */
export class ProviderBudgetLedger {
  private readonly windows = new Map<string, UsageWindow>();
  constructor(private readonly maxRequests: number, private readonly maxTokens: number, private readonly now = Date.now) {}
  reserve(tenant: string, requests: number, tokens: number) {
    const now = this.now();
    for (const [key, value] of this.windows) if (value.reset <= now && value.reservedRequests === 0) this.windows.delete(key);
    let record = this.windows.get(tenant);
    if (!record || record.reset <= now && record.reservedRequests === 0) {
      if (this.windows.size >= 1000 && !this.windows.has(tenant)) throw new GroupingError('BUDGET_EXHAUSTED', 'The provider budget registry is at capacity.');
      record = { usedRequests: 0, reservedRequests: 0, usedTokens: 0, reservedTokens: 0, reset: now + 3_600_000 };
      this.windows.set(tenant, record);
    }
    if (record.usedRequests + record.reservedRequests + requests > this.maxRequests || record.usedTokens + record.reservedTokens + tokens > this.maxTokens) throw new GroupingError('BUDGET_EXHAUSTED', 'The hourly provider request or estimated-token budget was reached before submission.');
    record.reservedRequests += requests; record.reservedTokens += tokens;
    let settled = false;
    return {
      settle: (usedRequests: number, actualTokens?: number) => {
        if (settled) return;
        settled = true;
        record.reservedRequests -= requests; record.reservedTokens -= tokens;
        record.usedRequests += Math.min(requests, Math.max(0, usedRequests));
        // Missing failure usage is conservatively charged against the reservation.
        record.usedTokens += actualTokens === undefined ? usedRequests ? tokens : 0 : Math.max(0, actualTokens);
      },
    };
  }
}
