import type { PaymentService } from './payment-service.js';
export function startReconciliationWorker(service: PaymentService,intervalMs: number,batchSize: number) {
 let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined; let active: Promise<void> | undefined;
 function run() { active = (async () => { try { const count = await service.reconcileBatch(batchSize); if (count > 0) console.info(`Payments reconciled ${count} candidates`); } catch { console.error('Payment reconciliation failed'); } })().finally(() => { active = undefined; if (!stopped) { timer = setTimeout(run,intervalMs); timer.unref(); } }); }
 run(); return { async stop() { stopped = true; clearTimeout(timer); await active; } };
}
