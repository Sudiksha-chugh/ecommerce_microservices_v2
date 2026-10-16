import { z } from 'zod';
import type { Limits } from './schemas.js';
export class SourceError extends Error {
    constructor(readonly code: 'timeout' | 'unavailable' | 'invalid_response' | 'oversized') { super(code); }
}
// Literal loopback addresses avoid DNS rebinding, metadata endpoints and proxy credentials.
// Remote backends require an authenticated operator-managed local tunnel.
export function backendEndpoint(raw: string): string { const u = new URL(raw); if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password || u.pathname !== '/' || u.search || u.hash)
    throw new Error('Backend requires literal loopback origin'); return u.origin; }
export async function boundedJson(url: string, limits: Limits, signal: AbortSignal, request: typeof fetch = fetch): Promise<unknown> {
    const timed = AbortSignal.timeout(limits.backendTimeoutMs), combined = AbortSignal.any([signal, timed]);
    try {
        const response = await request(url, { method: 'GET', redirect: 'error', signal: combined, headers: { Accept: 'application/json' } });
        if (!response.ok) {
            await response.body?.cancel();
            throw new SourceError('unavailable');
        }
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
            await response.body?.cancel();
            throw new SourceError('invalid_response');
        }
        if (Number(response.headers.get('content-length')) > limits.responseBytes) {
            await response.body?.cancel();
            throw new SourceError('oversized');
        }
        const reader = response.body?.getReader();
        if (!reader)
            throw new SourceError('invalid_response');
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
            while (true) {
                combined.throwIfAborted();
                const part = await reader.read();
                if (part.done)
                    break;
                size += part.value.byteLength;
                if (size > limits.responseBytes)
                    throw new SourceError('oversized');
                chunks.push(part.value);
            }
        }
        finally {
            await reader.cancel();
        }
        try {
            return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        }
        catch {
            throw new SourceError('invalid_response');
        }
    }
    catch (error) {
        if (error instanceof SourceError)
            throw error;
        throw new SourceError(combined.aborted ? 'timeout' : 'unavailable');
    }
}
export const finiteSample = z.tuple([z.number().finite().min(0), z.string().max(40).regex(/^(?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?|NaN|[-+]?Inf)$/i)]);
