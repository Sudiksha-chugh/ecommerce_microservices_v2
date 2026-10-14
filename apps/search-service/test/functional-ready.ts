import { randomUUID } from 'node:crypto';
import { Elasticsearch, InvalidProjectionError, SearchUnavailableError } from '../src/elasticsearch.js';
import { querySchema, searchBody } from '../src/query.js';
import { errorCode } from './setup-diagnostics.js';

// Infrastructure preflight uses real production APIs and their existing per-request
// budget. Its total deadline is the remainder of the runner's existing cold budget.
export async function functionalSearchReady(elastic: Elasticsearch, budgetMs: number, emit: (operation: string, values: Record<string, unknown>) => void) {
  if (!/^commerce_v2_products_probe_[a-f0-9]+$/.test(elastic.alias) || !Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('Unsafe functional preflight');
  const index = `${elastic.alias}_warm`, id = randomUUID(), now = new Date().toISOString();
  const deadline = performance.now() + budgetMs;
  const retry = async (operation: string, action: () => Promise<unknown>) => {
    let lastError: unknown;
    while (performance.now() < deadline) {
      const started = performance.now(); emit(operation, { stage: 'BEGIN', dependency: 'elasticsearch' });
      try {
        await action(); emit(operation, { stage: 'END', outcome: 'ok', durationMs: performance.now() - started }); return;
      } catch (error) {
        lastError = error; emit(operation, { stage: 'END', outcome: 'failed', code: errorCode(error), durationMs: performance.now() - started });
        if (error instanceof InvalidProjectionError || error instanceof SearchUnavailableError && /^ELASTICSEARCH_HTTP_(401|403)$/.test(error.code)) throw error;
      }
      // Bounded readiness polling, not a delay used to infer successful initialization.
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw lastError ?? new Error('Functional Elasticsearch readiness deadline exceeded');
  };
  try {
    await retry('ELASTIC_MAPPING_READY', () => elastic.create(index));
    await retry('ELASTIC_DOCUMENT_READY', () => elastic.put(index, { id, productVersion: 1, name: 'Readiness probe', description: 'Owned disposable probe', priceInPaise: 1, createdAt: now, updatedAt: now, deleted: false }));
    await retry('ELASTIC_REFRESH_READY', () => elastic.refresh(index));
    await retry('ELASTIC_ALIAS_READY', () => elastic.swap(index));
    await retry('ELASTIC_SEARCH_READY', async () => {
      const result = await elastic.search(searchBody(querySchema.parse({ q: 'Readiness', limit: 20 })));
      if (result.timed_out || result.hits.hits.length !== 1 || result.hits.hits[0]?._source.id !== id) throw new Error('Functional probe document not visible');
    });
  } finally {
    // An exact generated probe index is the sole target, including on partial failure.
    await elastic.request('DELETE', `/${index}`, undefined, [404]);
    emit('ELASTIC_PROBE_CLEANUP', { outcome: 'ok', index });
  }
}
