import { appendFileSync } from 'node:fs';
import type { Pool, PoolClient } from 'pg';

export function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return 'UNKNOWN';
  if (/connection timeout|timeout exceeded when trying to connect/i.test(error.message)) return 'PG_CONNECT_TIMEOUT';
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : error.name;
}

export function setupDiagnostics(snapshot: () => Record<string, unknown>) {
  let count = 0;
  const emit = (operation: string, values: Record<string, unknown> = {}) => {
    const row = { at: new Date().toISOString(), monotonicMs: performance.now(), pid: process.pid, operation, ...values };
    if (process.env.INTEGRATION_DIAGNOSTICS_FILE && count++ < 2000) appendFileSync(process.env.INTEGRATION_DIAGNOSTICS_FILE, JSON.stringify(row) + '\n');
  };
  const stage = async <T>(name: string, dependency: string, action: () => Promise<T>): Promise<T> => {
    const started = performance.now();
    emit(name, { stage: 'BEGIN', dependency, ...snapshot() });
    try {
      const result = await action();
      emit(name, { stage: 'END', dependency, durationMs: performance.now() - started, outcome: 'ok', ...snapshot() });
      return result;
    } catch (error) {
      emit(name, { stage: 'END', dependency, durationMs: performance.now() - started, outcome: 'failed', code: errorCode(error), ...snapshot() });
      throw error;
    }
  };
  return { emit, stage };
}

// Preserve both pg overloads: Pool.query uses callback acquisition, while transactions await it.
export function observePool(pool: Pool, name: string, emit: (operation: string, values: Record<string, unknown>) => void) {
  const connect = pool.connect.bind(pool);
  const state = () => ({ pool: name, total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount });
  pool.connect = ((callback?: (error: Error | undefined, client: PoolClient | undefined, done: (release?: unknown) => void) => void) => {
    const started = performance.now();
    emit('PG_ACQUIRE', { stage: 'BEGIN', ...state() });
    const finish = (error?: unknown) => emit('PG_ACQUIRE', { stage: 'END', durationMs: performance.now() - started, outcome: error ? 'failed' : 'ok', ...(error ? { code: errorCode(error) } : {}), ...state() });
    if (callback) return connect((error, client, done) => { finish(error); callback(error, client, done); });
    return connect().then(client => { finish(); return client; }, error => { finish(error); throw error; });
  }) as Pool['connect'];
}
