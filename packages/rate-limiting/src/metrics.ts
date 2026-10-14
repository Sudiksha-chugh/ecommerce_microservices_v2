import type { PolicyName } from './policies.js';
export type DecisionKind = 'allowed' | 'denied' | 'fail_open' | 'fail_closed';
export class RateLimitMetrics {
  private readonly counters: Record<string, number> = {};
  private readonly durations: Record<string, { count: number; sum: number; max: number }> = {};
  observe(policy: PolicyName, decision: DecisionKind, durationMs: number): void {
    const key = `rate_limit_${decision}_total:${policy}`;
    this.counters[key] = (this.counters[key] ?? 0) + 1;
    if (decision.startsWith('fail_')) {
      const errors = `rate_limit_redis_errors_total:${policy}`;
      this.counters[errors] = (this.counters[errors] ?? 0) + 1;
    }
    const duration = this.durations[policy] ??= { count: 0, sum: 0, max: 0 };
    duration.count++; duration.sum += durationMs; duration.max = Math.max(duration.max, durationMs);
  }
  snapshot() { return { counters: { ...this.counters }, rate_limit_decision_duration_ms: structuredClone(this.durations) }; }
}
