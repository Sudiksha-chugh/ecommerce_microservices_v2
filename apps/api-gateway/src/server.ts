import { loadGatewayEnvironment } from '@ecommerce/config';
import { createApp } from './app.js';

const environment = loadGatewayEnvironment();
const server = createApp(environment).listen(environment.PORT, environment.HOST, () => {
  console.info(`API Gateway listening on http://${environment.HOST}:${environment.PORT}`);
});

server.on('error', (error: Error) => {
  console.error('API Gateway server error:', error);
  process.exitCode = 1;
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`${signal} received; closing API Gateway`);

  const deadline = setTimeout(() => {
    console.error('Graceful shutdown deadline exceeded');
    server.closeAllConnections();
    process.exit(1);
  }, environment.SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  // Stop accepting connections and let active requests finish.
  server.close((error) => {
    clearTimeout(deadline);
    if (error) {
      console.error('API Gateway shutdown failed:', error);
      process.exitCode = 1;
    }
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
