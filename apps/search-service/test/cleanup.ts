import { Elasticsearch } from '../src/elasticsearch.js';

// Fixture-only: callers must first stop consumers and await all their handlers.
// An exact generation belonging to this fixture is the only deletion target.
export async function emptyOwnedIndex(elastic: Elasticsearch, index: string, quiesce: () => Promise<void>) {
  if (!index.startsWith(`${elastic.alias}_g_`) || !/^[a-z0-9_]+$/.test(index)) throw new Error('Unowned fixture generation');
  await quiesce();
  await elastic.refresh(index);
  const result = await elastic.request<{version_conflicts: number; failures: unknown[]; timed_out: boolean}>(
    'POST', `/${index}/_delete_by_query?refresh=true&wait_for_completion=true`, {query: {match_all: {}}},
  );
  if (result.timed_out || result.version_conflicts !== 0 || result.failures.length !== 0) throw new Error('Fixture deletion incomplete');
  const remaining = await elastic.request<{hits: {total: {value: number}}}>(
    'POST', `/${index}/_search`, {size: 0, track_total_hits: true, query: {match_all: {}}},
  );
  if (remaining.hits.total.value !== 0) throw new Error('Fixture index is not empty');
}
