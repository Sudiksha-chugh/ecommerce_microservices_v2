import { loadAuthEnvironment } from '@ecommerce/config';
import { createApp } from './app.js';
import { createPool, verifyDatabaseBoundary } from './db/pool.js';
import { readFile } from 'node:fs/promises';
import { UserRepository } from './user-repository.js';
import { AuthService } from './auth-service.js';
import { createTokenService } from './token-service.js';

const environment = loadAuthEnvironment();
const tokens = await createTokenService(
  await readFile(environment.AUTH_JWT_PRIVATE_KEY_FILE, 'utf8'),
  await readFile(environment.JWT_PUBLIC_KEY_FILE, 'utf8'),
  { issuer: environment.JWT_ISSUER, audience: environment.JWT_AUDIENCE },
  environment.JWT_ACCESS_TOKEN_TTL_SECONDS,
);
const pool = createPool(environment);
let auth: AuthService;
try {
  await verifyDatabaseBoundary(pool);
  auth = await AuthService.create(new UserRepository(pool), tokens);
} catch {
  await pool.end();
  throw new Error('Auth startup failed; check database readiness and dedicated role permissions');
}
const server = createApp(auth,process.env.NOTIFICATION_LOOKUP_KEY?{key:process.env.NOTIFICATION_LOOKUP_KEY,lookup:id=>new UserRepository(pool).findById(id)}:undefined).listen(environment.AUTH_PORT, environment.AUTH_HOST, () => {
  console.info(`Auth Service listening on http://${environment.AUTH_HOST}:${environment.AUTH_PORT}`);
});

server.on('error', (error: Error) => {
  console.error('Auth Service server error:', error);
  process.exitCode = 1;
  void pool.end();
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`${signal} received; closing Auth Service`);

  const deadline = setTimeout(() => {
    console.error('Graceful shutdown deadline exceeded');
    server.closeAllConnections();
    process.exit(1);
  }, environment.SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  // Stop accepting connections and let active requests finish.
  server.close(async (error) => {
    if (error) {
      console.error('Auth Service shutdown failed:', error);
      process.exitCode = 1;
    }
    try { await pool.end(); }
    catch { console.error('Auth pool shutdown failed'); process.exitCode = 1; }
    finally { clearTimeout(deadline); }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
