import { performance } from 'node:perf_hooks';
import { bucketKey, type RateIdentity } from './identity.js';
import { defaultPolicies, type Policies, type PolicyName } from './policies.js';
import type { BucketResult, DecisionStore } from './redis-store.js';
export interface RateDecision extends BucketResult { allowed: boolean; policy: PolicyName; capacity: number; redisDurationMs: number }
export class DistributedRateLimiter {
  constructor(readonly store: DecisionStore, readonly prefix = 'ecommerce:v2:ratelimit:v1', readonly policies: Policies = defaultPolicies) {}
  async decide(names: PolicyName[], identity: RateIdentity): Promise<RateDecision> {
    const unique = [...new Set(names)];
    const start = performance.now();
    const result = await this.store.decide(unique.map(name => ({ key: bucketKey(this.prefix, name, identity), policy: this.policies[name] })));
    let index = 0;
    for (let i = 1; i < result.buckets.length; i++) {
      const candidate = result.buckets[i]!;
      const current = result.buckets[index]!;
      if (result.allowed ? candidate.remaining / this.policies[unique[i]!].capacity < current.remaining / this.policies[unique[index]!].capacity
        : candidate.retryAfterMs > current.retryAfterMs) index = i;
    }
    const policy = unique[index]!;
    return { ...result.buckets[index]!, allowed: result.allowed, policy, capacity: this.policies[policy].capacity,
      redisDurationMs: performance.now() - start };
  }
}
