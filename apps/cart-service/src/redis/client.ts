import { createClient } from '@redis/client';

export function createRedisClient(url: string, connectTimeoutMs = 2000) {
  const client = createClient({
    url, disableOfflineQueue: true, commandsQueueMaxLength: 1000,
    socket: {
      connectTimeout: connectTimeoutMs,
      reconnectStrategy: (retries) => Math.min(100 * 2 ** Math.min(retries, 5), 2000),
    },
  });
  // Never log URLs, credentials, tokens, or internal Redis errors.
  client.on('error', () => console.error('Cart Redis connection failed'));
  return client;
}
export type CartRedisClient = ReturnType<typeof createRedisClient>;

export async function connectRedis(client: CartRedisClient, timeoutMs: number): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          client.destroy();
          reject(new Error('Cart Redis connection failed'));
        }, timeoutMs);
      }),
    ]);
  } catch {
    client.destroy();
    throw new Error('Cart Redis connection failed');
  } finally { clearTimeout(deadline); }
}
