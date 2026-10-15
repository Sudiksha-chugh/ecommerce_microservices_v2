import { readFile } from 'node:fs/promises';
import { createTokenVerifier } from '@ecommerce/security';
import { loadCatalogEnvironment } from '@ecommerce/config';
import { createApp } from './app.js';
import { createPool } from './db/pool.js';
import { bootstrapMessaging, signProducerEvent } from '@ecommerce/messaging';
import { OutboxRepository, OutboxWorker } from '@ecommerce/event-persistence';
import { z } from 'zod';
import { CatalogSearchSource } from './search-source.js';
import { ProductRepository } from './product-repository.js';

const environment = loadCatalogEnvironment();
const verifyToken = await createTokenVerifier(
  await readFile(environment.JWT_PUBLIC_KEY_FILE, 'utf8'),
  { issuer: environment.JWT_ISSUER, audience: environment.JWT_AUDIENCE },
);
const pool = createPool(environment);
const searchSettings=z.object({CATALOG_SEARCH_EXPORT_ENABLED:z.enum(['true','false']).default('false'),CATALOG_SEARCH_PUBLISH_ENABLED:z.enum(['true','false']).default('false'),SEARCH_LOOKUP_KEY:z.preprocess(v=>v===''?undefined:v,z.string().min(32).optional()),CATALOG_EVENT_KEY:z.preprocess(v=>v===''?undefined:v,z.string().min(32).optional())}).parse(process.env);
if(searchSettings.CATALOG_SEARCH_EXPORT_ENABLED==='true'&&!searchSettings.SEARCH_LOOKUP_KEY||searchSettings.CATALOG_SEARCH_PUBLISH_ENABLED==='true'&&!searchSettings.CATALOG_EVENT_KEY)throw new Error('Catalog search requires scoped keys');
const messaging=bootstrapMessaging('catalog',{...process.env,MESSAGING_ENABLED:searchSettings.CATALOG_SEARCH_PUBLISH_ENABLED,MESSAGING_DIAGNOSTIC_CONSUMERS:'false'});
const outbox=searchSettings.CATALOG_SEARCH_PUBLISH_ENABLED==='true'?new OutboxWorker(new OutboxRepository(pool),{publish:event=>messaging.publish(signProducerEvent(event,searchSettings.CATALOG_EVENT_KEY!))}):undefined;
outbox?.start();
const source=searchSettings.CATALOG_SEARCH_EXPORT_ENABLED==='true'?new CatalogSearchSource(pool):undefined;
const server = createApp(new ProductRepository(pool), verifyToken,source,searchSettings.SEARCH_LOOKUP_KEY).listen(environment.CATALOG_PORT, environment.CATALOG_HOST, () => {
  console.info(`Catalog Service listening on http://${environment.CATALOG_HOST}:${environment.CATALOG_PORT}`);
});

server.on('error', (error: Error) => {
  console.error('Catalog Service server error:', error);
  process.exitCode = 1;
  void pool.end();
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`${signal} received; closing Catalog Service`);

  const deadline = setTimeout(() => {
    console.error('Graceful shutdown deadline exceeded');
    server.closeAllConnections();
    process.exit(1);
  }, environment.SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  // Stop accepting connections and let active requests finish.
  server.close(async (error) => {
    if (error) {
      console.error('Catalog Service shutdown failed:', error);
      process.exitCode = 1;
    }
    try { await outbox?.stop(); await messaging.stop(); await pool.end(); }
    catch { console.error('Catalog pool shutdown failed'); process.exitCode = 1; }
    finally { clearTimeout(deadline); }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
