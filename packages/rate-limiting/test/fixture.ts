import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, createConnection, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createClient } from '@redis/client';
import { RedisRateLimitStore, DistributedRateLimiter, defaultPolicies, type Policies } from '../src/index.js';
const exec = promisify(execFile);
export async function isolatedRedis() {
  // The experimental container runner already owns a fresh Redis in its store namespace.
  // Reuse only its generated DB-15 URL, avoiding Docker access inside the test container.
  if (process.env.INTEGRATION_ENV_DIR) {
    const { readFile } = await import('node:fs/promises'); const { join } = await import('node:path');
    const contents = await readFile(join(process.env.INTEGRATION_ENV_DIR, '.env.cart'), 'utf8');
    const url = contents.match(/^CART_TEST_REDIS_URL=(.+)$/m)?.[1];
    if (!url || !['redis:', 'rediss:'].includes(new URL(url).protocol) || new URL(url).pathname !== '/15') throw new Error('Expected isolated test Redis DB 15');
    const client = createClient({ url, disableOfflineQueue: true, socket: { connectTimeout: 2000, reconnectStrategy: false } });
    client.on('error', () => {}); const started=performance.now(); await client.connect();console.info(JSON.stringify({component:'test-readiness',store:'redis',at:new Date().toISOString(),durationMs:performance.now()-started}));
    return { url, port: Number(new URL(url).port || 6379), client, close: async () => { if (client.isOpen) client.destroy(); } };
  }
  const project = `commerce-v2-rate-limit-test-${randomUUID().slice(0, 8)}`;
  const args = ['compose', '-p', project, '-f', 'compose.rate-limit-test.yaml'];
  const command = (tail: string[]) => exec('docker', [...args, ...tail], { timeout: 60_000, maxBuffer: 100_000 });
  try {
    await command(['up', '-d', '--wait']);
    const { stdout } = await command(['port', 'redis', '6379']);
    const port = Number(stdout.trim().split(':').at(-1));
    if (!port) throw new Error('Missing isolated Redis port');
    const url = `redis://127.0.0.1:${port}/15`;
    // Setup must reject a failed connection instead of reconnecting forever
    // beyond the suite hook and losing the actual infrastructure error.
    const client = createClient({ url, disableOfflineQueue: true, socket: { connectTimeout: 2000, reconnectStrategy: false } });
    client.on('error', () => {});
    await client.connect();
    return { url, port, client, close: async () => { if (client.isOpen) client.destroy(); await command(['down', '--remove-orphans']); } };
  } catch (error) { await command(['down', '--remove-orphans']); throw error; }
}
export async function ready(store: RedisRateLimitStore, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (!store.ready && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10));
  if (!store.ready) throw new Error('Isolated rate-limit Redis not ready');
}
export async function storeFixture(url: string, overrides: Partial<Policies> = {}, commandTimeoutMs = 500, maxPending = 1000) {
  const store = new RedisRateLimitStore({ url, connectTimeoutMs: 100, commandTimeoutMs, maxPending });
  await store.start(); await ready(store);
  const prefix = `ecommerce:v2:ratelimit:v1:test-${randomUUID()}`;
  return { store, prefix, limiter: new DistributedRateLimiter(store, prefix, { ...defaultPolicies, ...overrides }) };
}
export async function upstream() {
  const behavior = { status: 200 };
  const seen: { method: string; path: string; body: string; key: string | undefined; authorization: string | undefined }[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    seen.push({ method: req.method!, path: req.url!, body, key: req.headers['idempotency-key'] as string | undefined, authorization: req.headers.authorization });
    res.statusCode = behavior.status;
    res.setHeader('Content-Type', 'application/json'); res.end('{"forwarded":true}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, behavior,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
// A real TCP proxy provides deterministic outage/slow-reply gates without production switches.
export async function redisProxy(redisPort: number) {
  const sockets = new Set<Socket>();
  let paused = false;
  let gate: (() => void) | undefined;
  let captured: Promise<void> = Promise.resolve();
  const buffers: { client: Socket; chunk: Buffer }[] = [];
  const server = createTcpServer(client => {
    const remote = createConnection({ host: '127.0.0.1', port: redisPort });
    sockets.add(client); sockets.add(remote);
    client.on('data', chunk => remote.write(chunk));
    remote.on('data', chunk => {
      if (paused) { buffers.push({ client, chunk }); gate?.(); }
      else client.write(chunk);
    });
    client.on('error', () => remote.destroy()); remote.on('error', () => client.destroy());
    client.on('close', () => { sockets.delete(client); remote.destroy(); });
    remote.on('close', () => { sockets.delete(remote); client.destroy(); });
  });
  const listen = (port = 0) => new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  await listen();
  const port = (server.address() as AddressInfo).port;
  return {
    url: `redis://127.0.0.1:${port}/15`, port,
    pause: () => { paused = true; captured = new Promise(resolve => { gate = resolve; }); },
    captured: () => captured,
    release: () => { paused = false; gate = undefined; for (const { client, chunk } of buffers.splice(0)) if (!client.destroyed) client.write(chunk); },
    disconnect: async () => { for (const socket of sockets) socket.destroy(); buffers.splice(0); await new Promise<void>(resolve => server.close(() => resolve())); },
    recover: () => listen(port),
    close: async () => { for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

export async function gatewayProcess(redisUrl: string, upstreamUrl: string, publicPem: string) {
  const { spawn } = await import('node:child_process');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'commerce-v2-rate-limit-process-'));
  const keyFile = join(directory, 'public.pem'); await writeFile(keyFile, publicPem);
  const reservation = createTcpServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as AddressInfo).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/api-gateway/src/server.ts'], { env: {
    ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port),
    RATE_LIMIT_ENABLED: 'true', RATE_LIMIT_REDIS_URL: redisUrl,
    RATE_LIMIT_KEY_PREFIX: `ecommerce:v2:ratelimit:v1:test-${randomUUID()}`,
    RATE_LIMIT_CONNECT_TIMEOUT_MS: '100', RATE_LIMIT_COMMAND_TIMEOUT_MS: '200', RATE_LIMIT_MAX_PENDING: '20',
    RATE_LIMIT_TRUSTED_PROXIES: '', RATE_LIMIT_POLICY_OVERRIDES: '{}', RATE_LIMIT_FAIL_OPEN_PUBLIC: 'true',
    JWT_PUBLIC_KEY_FILE: keyFile, JWT_ISSUER: 'test-auth', JWT_AUDIENCE: 'test-api',
    CATALOG_SERVICE_URL: upstreamUrl, AUTH_SERVICE_URL: upstreamUrl, SHUTDOWN_TIMEOUT_MS: '2000',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk.toString(); }); child.stderr.on('data', chunk => { output += chunk.toString(); });
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const url = `http://127.0.0.1:${port}`;
  const waitFor = async (path: string, status: number) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { if ((await fetch(url + path, { signal: AbortSignal.timeout(200) })).status === status) return; } catch { /* Startup/reconnect only. */ }
      if (child.exitCode !== null) throw new Error(`Gateway exited before readiness: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Gateway process readiness deadline exceeded');
  };
  return { child, exit, url, waitFor, output: () => output,
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exit; await rm(directory, { recursive: true, force: true });
    } };
}
