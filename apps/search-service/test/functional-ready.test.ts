import { afterEach, describe, expect, it, vi } from 'vitest';
import { Elasticsearch, SearchUnavailableError } from '../src/elasticsearch.js';
import { functionalSearchReady } from './functional-ready.js';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('Operation-level Search readiness', () => {
  it('does not accept healthy metadata until the indexed document is searchable', async () => {
    vi.useFakeTimers();
    const elastic = new Elasticsearch('http://owned-test.invalid', 'commerce_v2_products_probe_abcdef', 2000);
    const create = vi.spyOn(elastic, 'create').mockResolvedValue(undefined);
    let documentId = '';
    vi.spyOn(elastic, 'put').mockImplementation(async (_index, document) => { documentId = document.id; });
    vi.spyOn(elastic, 'refresh').mockResolvedValue(undefined);
    vi.spyOn(elastic, 'swap').mockResolvedValue(undefined);
    const search = vi.spyOn(elastic, 'search').mockRejectedValueOnce(new SearchUnavailableError('ELASTICSEARCH_TIMEOUT')).mockResolvedValueOnce({timed_out:true,hits:{hits:[]}}).mockImplementation(async () => ({ timed_out: false, hits: { hits: [{ _source: { id: documentId } as never, sort: [] }] } }));
    const cleanup = vi.spyOn(elastic, 'request').mockResolvedValue({});
    const records: Record<string, unknown>[] = [];
    const ready = functionalSearchReady(elastic, 100, (operation, values) => records.push({ operation, ...values }));
    await vi.advanceTimersByTimeAsync(0); expect(search).toHaveBeenCalledOnce();
    expect(records.some(row => row.operation === 'ELASTIC_SEARCH_READY' && row.outcome === 'ok')).toBe(false);
    await vi.advanceTimersByTimeAsync(20); expect(search).toHaveBeenCalledTimes(2);
    expect(records.some(row => row.operation === 'ELASTIC_SEARCH_READY' && row.outcome === 'ok')).toBe(false);
    await vi.advanceTimersByTimeAsync(20); await ready;
    expect(search).toHaveBeenCalledTimes(3);
    expect(search.mock.calls[0]?.[0]).toMatchObject({query:{bool:{must:[{multi_match:{query:'Readiness',type:'bool_prefix'}}]}},sort:[{_score:'desc'},{id:'asc'}]});
    expect(create).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledExactlyOnceWith('DELETE', '/commerce_v2_products_probe_abcdef_warm', undefined, [404]);
  });
  it('rejects an unowned alias before any Elasticsearch operation', async () => {
    const elastic = new Elasticsearch('http://owned-test.invalid', 'commerce_v2_products_current', 2000);
    const cleanup = vi.spyOn(elastic, 'request');
    await expect(functionalSearchReady(elastic, 100, () => {})).rejects.toThrow('Unsafe functional preflight');
    expect(cleanup).not.toHaveBeenCalled();
  });
  it('reports permission failure and cleans only its exact owned probe index', async () => {
    const elastic = new Elasticsearch('http://owned-test.invalid', 'commerce_v2_products_probe_123abc', 2000);
    vi.spyOn(elastic, 'create').mockRejectedValue(new SearchUnavailableError('ELASTICSEARCH_HTTP_403'));
    const cleanup = vi.spyOn(elastic, 'request').mockResolvedValue({});
    await expect(functionalSearchReady(elastic, 100, () => {})).rejects.toMatchObject({ code: 'ELASTICSEARCH_HTTP_403' });
    expect(cleanup).toHaveBeenCalledExactlyOnceWith('DELETE', '/commerce_v2_products_probe_123abc_warm', undefined, [404]);
  });
});
