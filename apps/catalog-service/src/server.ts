import { readFile } from 'node:fs/promises';
import { createTokenVerifier } from '@ecommerce/security';
import { loadCatalogEnvironment } from '@ecommerce/config';
import { createApp } from './app.js';
import { createPool } from './db/pool.js';
import { ProductRepository } from './product-repository.js';

const environment = loadCatalogEnvironment();
const verifyToken = await createTokenVerifier(
  await readFile(environment.JWT_PUBLIC_KEY_FILE, 'utf8'),
  { issuer: environment.JWT_ISSUER, audience: environment.JWT_AUDIENCE },
);
const pool = createPool(environment);
const server = createApp(new ProductRepository(pool), verifyToken).listen(environment.CATALOG_PORT, environment.CATALOG_HOST, () => {
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
    try { await pool.end(); }
    catch { console.error('Catalog pool shutdown failed'); process.exitCode = 1; }
    finally { clearTimeout(deadline); }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
