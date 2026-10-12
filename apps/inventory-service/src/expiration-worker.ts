import type { InventoryRepository } from './inventory-repository.js';
export function startExpirationWorker(repository: InventoryRepository, intervalMs: number, batchSize: number) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  function run() {
    active = (async () => {
      try {
        const count = await repository.expireBatch(batchSize);
        if (count > 0) console.info(`Inventory expired ${count} reservation groups`);
      } catch { console.error('Inventory expiration failed'); }
    })().finally(() => {
      active = undefined;
      if (!stopped) { timer = setTimeout(run, intervalMs); timer.unref(); }
    });
  }
  run();
  return { async stop() { stopped = true; clearTimeout(timer); await active; } };
}
