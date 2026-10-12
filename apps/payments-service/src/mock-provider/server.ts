import { createMockProvider } from './app.js';
import { mockEnvironment,mockPool,verifyMockBoundary } from './config.js';
const env=mockEnvironment(),pool=mockPool(env);
try { await verifyMockBoundary(pool); } catch { await pool.end(); throw new Error('Mock provider startup failed'); }
const server=createMockProvider(pool,() => env.MOCK_SCENARIO,env.MOCK_DELAY_MS).listen(env.MOCK_PORT,env.MOCK_HOST,() => console.info(`Mock provider listening on http://${env.MOCK_HOST}:${env.MOCK_PORT}`));
let closing=false;
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,() => { if (closing) return; closing=true; const timer=setTimeout(() => {server.closeAllConnections();process.exit(1);},10000);timer.unref();server.close(async () => {await pool.end();clearTimeout(timer);}); });
server.on('error',() => { console.error('Mock provider server failed');process.exitCode=1;void pool.end(); });
