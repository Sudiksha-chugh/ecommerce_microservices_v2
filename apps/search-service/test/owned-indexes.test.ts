import { afterEach, describe, expect, it, vi } from 'vitest';
import { Elasticsearch } from '../src/elasticsearch.js';
import { OwnedSearchIndexes } from './owned-indexes.js';
afterEach(() => vi.restoreAllMocks());
describe('Whole-fixture owned index cleanup', () => {
  const alias = 'commerce_v2_products_test_012345abcdef';
  it('drains writers and deletes ambiguous creations, without repeating completed deletion', async () => {
    const owned = new OwnedSearchIndexes(alias), index = `${alias}_g_${'a'.repeat(32)}`;
    owned.created(index); owned.created(`${alias}_warm`); owned.deleted(`${alias}_warm`);
    const elastic = new Elasticsearch('http://owned-test.invalid', alias);
    const request = vi.spyOn(elastic, 'request').mockResolvedValue({});
    let release!: () => void;
    const drained = new Promise<void>(resolve => { release = resolve; });
    const cleanup = owned.cleanup(elastic, () => drained);
    expect(request).not.toHaveBeenCalled(); release(); await cleanup;
    expect(request).toHaveBeenCalledExactlyOnceWith('DELETE', `/${index}`, undefined, [404]);
    await owned.cleanup(elastic, async () => {}); expect(request).toHaveBeenCalledOnce();
  });
  it('rejects another fixture generation and leaves failed cleanup pending for retry', async () => {
    const owned = new OwnedSearchIndexes(alias), index = `${alias}_g_${'b'.repeat(32)}`;
    expect(() => owned.created(`${alias}_other_g_${'c'.repeat(32)}`)).toThrow('Unowned');
    owned.created(index);
    const elastic = new Elasticsearch('http://owned-test.invalid', alias);
    const request = vi.spyOn(elastic, 'request').mockRejectedValueOnce(new Error('lost cleanup response')).mockResolvedValue({});
    await expect(owned.cleanup(elastic, async () => {})).rejects.toThrow('lost cleanup response');
    await owned.cleanup(elastic, async () => {});
    expect(request.mock.calls.map(call => call[1])).toEqual([`/${index}`, `/${index}`]);
  });
});
