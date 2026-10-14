import type { Elasticsearch } from '../src/elasticsearch.js';

// Explicit creation ledger, including ambiguous writes and generations created by
// crash-test subprocesses from jobs admitted through the parent repository.
export class OwnedSearchIndexes {
  private readonly indexes = new Set<string>();
  constructor(private readonly alias: string) {
    if (!/^commerce_v2_products_test_[a-f0-9]{12}$/.test(alias)) throw new Error('Unsafe fixture alias');
  }
  created(index: string) {
    const generation = index.startsWith(`${this.alias}_g_`) && /^[a-f0-9]{32}$/.test(index.slice(`${this.alias}_g_`.length));
    if (!generation && index !== `${this.alias}_warm` && index !== `${this.alias}_invalid`) throw new Error('Unowned fixture index');
    this.indexes.add(index);
  }
  deleted(index: string) { this.indexes.delete(index); }
  async cleanup(elastic: Elasticsearch, drain: () => Promise<void>) {
    await drain();
    for (const index of [...this.indexes]) {
      await elastic.request('DELETE', `/${index}`, undefined, [404]);
      this.indexes.delete(index);
    }
  }
}
