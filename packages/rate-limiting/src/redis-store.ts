import { readFileSync } from 'node:fs';
import { createClient } from '@redis/client';
import { RateLimitStoreError } from './errors.js';
import { policySchema, type BucketPolicy } from './policies.js';
const script = readFileSync(new URL('./scripts/token-bucket.lua', import.meta.url), 'utf8');
export interface Bucket { key: string; policy: BucketPolicy }
export interface BucketResult { remaining: number; retryAfterMs: number; resetMs: number }
export interface StoreDecision { allowed: boolean; buckets: BucketResult[] }
export interface DecisionStore { decide(buckets: Bucket[]): Promise<StoreDecision>; readonly ready: boolean }
export interface StoreOptions { url: string; connectTimeoutMs: number; commandTimeoutMs: number; maxPending: number }
export class RedisRateLimitStore implements DecisionStore {
  private client: ReturnType<RedisRateLimitStore['makeClient']>;
  private started = false;
  private connectionTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private pending = new Set<Promise<StoreDecision>>();
  constructor(private readonly options: StoreOptions) {
    this.client = this.makeClient();
  }
  private makeClient() {
    const client = createClient({ url: this.options.url, disableOfflineQueue: true,
      // Redis handshakes also use this queue; external decisions have their own exact bound.
      commandsQueueMaxLength: Math.max(8, this.options.maxPending),
      socket: { connectTimeout: this.options.connectTimeoutMs,
        reconnectStrategy: retries => Math.min(100 * 2 ** Math.min(retries, 5), 2000) },
    });
    // Errors become bounded request decisions/readiness. Never print client messages or connection URLs.
    client.on('connect', () => {
      // A TCP connect can complete after destroy() while the client is awaiting socket creation.
      // Close that late socket too; it must not start an orphaned handshake during shutdown.
      if (this.closed || this.client !== client) { client.destroy(); return; }
      clearTimeout(this.connectionTimer);
      this.connectionTimer = setTimeout(() => {
        if (!client.isReady) this.replaceConnection(client);
      }, this.options.connectTimeoutMs);
    });
    const clearHandshake = () => { if (this.client === client) clearTimeout(this.connectionTimer); };
    client.on('ready', clearHandshake);
    client.on('error', clearHandshake);
    return client;
  }
  private replaceConnection(client: ReturnType<RedisRateLimitStore['makeClient']>): void {
    if (this.client !== client || this.closed) return;
    clearTimeout(this.connectionTimer);
    if (client.isOpen) client.destroy();
    this.client = this.makeClient();
    void this.client.connect().catch(() => {});
  }
  get ready(): boolean { return !this.closed && this.client.isReady; }
  async start(): Promise<boolean> {
    if (this.closed) return false;
    if (!this.started) {
      this.started = true;
      void this.client.connect().catch(() => {});
    }
    if (this.ready) return true;
    const client = this.client;
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); client.off('ready', onReady); resolve(this.ready); };
      const onReady = () => done();
      const timer = setTimeout(done, this.options.connectTimeoutMs);
      client.once('ready', onReady);
    });
  }
  decide(buckets: Bucket[]): Promise<StoreDecision> {
    if (this.closed) return Promise.reject(new RateLimitStoreError('CLOSED'));
    if (!this.ready) return Promise.reject(new RateLimitStoreError('UNAVAILABLE'));
    if (this.pending.size >= this.options.maxPending) return Promise.reject(new RateLimitStoreError('SATURATED'));
    if (!buckets.length || buckets.length > 8 || new Set(buckets.map(b => b.key)).size !== buckets.length)
      return Promise.reject(new RateLimitStoreError('CONFIGURATION'));
    try { for (const bucket of buckets) policySchema.parse(bucket.policy); }
    catch { return Promise.reject(new RateLimitStoreError('CONFIGURATION')); }
    const operation = this.execute(buckets);
    this.pending.add(operation);
    void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
    return operation;
  }
  private async execute(buckets: Bucket[]): Promise<StoreDecision> {
    const client = this.client;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const args = ['EVAL', script, String(buckets.length), ...buckets.map(b => b.key),
        ...buckets.flatMap(b => [String(b.policy.capacity), String(b.policy.refillTokens), String(b.policy.windowMs)])];
      const result = await Promise.race([
        client.sendCommand(args, { timeout: this.options.commandTimeoutMs }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new RateLimitStoreError('TIMEOUT'));
            // The command may already have executed. Never replay it. Drop stalled reply queues.
            this.replaceConnection(client);
          }, this.options.commandTimeoutMs);
        }),
      ]) as unknown as [number, ...number[][]];
      if (!Array.isArray(result) || ![0, 1].includes(result[0]) || result.length !== buckets.length + 1) throw new Error();
      const values = result.slice(1) as number[][];
      if (values.some(value => !Array.isArray(value) || value.length !== 3 || value.some(n => !Number.isSafeInteger(n) || n < 0))) throw new Error();
      return { allowed: result[0] === 1, buckets: values.map(v => ({ remaining: v[0]!, retryAfterMs: v[1]!, resetMs: v[2]! })) };
    } catch (error) {
      if (error instanceof RateLimitStoreError) throw error;
      const name = error instanceof Error ? error.name : '';
      const message = error instanceof Error ? error.message : '';
      const code = this.closed ? 'CLOSED' : name.includes('Timeout') || name === 'AbortError' ? 'TIMEOUT'
        : message.includes('RL_POLICY_MISMATCH') || message.includes('RL_INVALID_STATE') ? 'CONFIGURATION'
        : message.includes('queue') ? 'SATURATED' : 'UNAVAILABLE';
      throw new RateLimitStoreError(code);
    } finally { clearTimeout(timer); }
  }
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.connectionTimer);
    // Destroy cancels reconnects and queued commands, including a stalled socket; shutdown stays bounded.
    if (this.client.isOpen) this.client.destroy();
    await Promise.allSettled([...this.pending]);
  }
}
