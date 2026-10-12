export class UpstreamRequestError extends Error {
  constructor(public readonly status: 502 | 504, message: string) {
    super(message);
  }
}

export async function requestUpstream(origin: string, path: string, timeoutMs: number,
  options: { method: string; body?: string; contentType?: string; authorization?: string; idempotencyKey?: string } = { method: 'GET' },
  service: 'Catalog' | 'Auth' | 'Cart' | 'Orders' | 'Inventory' = 'Catalog',
) {
  const controller = new AbortController();
  // Keep the deadline active until the full response body has been read.
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(path, origin), {
      signal: controller.signal,
      redirect: 'error',
      method: options.method,
      ...(options.body !== undefined ? { body: options.body } : {}),
      headers: {
        accept: 'application/json',
        ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
        ...(options.authorization ? { authorization: options.authorization } : {}),
        ...(options.contentType ? { 'content-type': options.contentType } : {}),
      },
    });
    if (response.status >= 500 && service === 'Catalog') {
      await response.body?.cancel();
      throw new UpstreamRequestError(502, `${service} Service unavailable`);
    }
    return {
      status: response.status,
      location: response.headers.get('location'),
      cacheControl: response.headers.get('cache-control'),
      wwwAuthenticate: response.headers.get('www-authenticate'),
      contentType: response.headers.get('content-type') ?? 'application/json',
      body: await response.text(),
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new UpstreamRequestError(504, `${service} Service request timed out`);
    }
    if (error instanceof UpstreamRequestError) throw error;
    throw new UpstreamRequestError(502, `${service} Service unavailable`);
  } finally {
    clearTimeout(deadline);
  }
}
