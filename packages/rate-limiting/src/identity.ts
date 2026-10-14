import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import type { Identity } from '@ecommerce/security';
export function normalizeIp(value: string): string {
  if (!isIP(value) || value.includes('%')) throw new Error('Invalid client IP');
  const address = ipaddr.process(value);
  return address.toNormalizedString();
}
export function createProxyTrust(entries: string[]): (address: string) => boolean {
  const ranges = entries.map(entry => {
    const [address, bits] = entry.split('/');
    if (!address || !isIP(address) || address.includes('%') || entry.split('/').length > 2) throw new Error('Invalid trusted proxy');
    const parsed = ipaddr.process(address);
    const maximum = parsed.kind() === 'ipv4' ? 32 : 128;
    if (bits !== undefined && (!/^\d+$/.test(bits) || Number(bits) < 1 || Number(bits) > maximum)) throw new Error('Invalid trusted proxy CIDR');
    return { parsed, prefix: bits === undefined ? maximum : Number(bits) };
  });
  return address => {
    try {
      const parsed = ipaddr.process(normalizeIp(address));
      return ranges.some(range => parsed.kind() === range.parsed.kind() && (parsed.kind() === 'ipv4'
        ? (parsed as ipaddr.IPv4).match(range.parsed as ipaddr.IPv4, range.prefix)
        : (parsed as ipaddr.IPv6).match(range.parsed as ipaddr.IPv6, range.prefix)));
    } catch { return false; }
  };
}
export interface RateIdentity { type: 'ip' | 'user'; value: string }
export function extractIdentity(ip: string, verified?: Identity, forceIp = false): RateIdentity {
  return verified && !forceIp ? { type: 'user', value: verified.id } : { type: 'ip', value: normalizeIp(ip) };
}
export function bucketKey(prefix: string, policy: string, identity: RateIdentity): string {
  const hash = createHash('sha256').update(`${identity.type}\0${identity.value}`).digest('hex');
  return `${prefix}:${policy}:${hash}`;
}
