const MAX_SAFE_MONEY = BigInt(Number.MAX_SAFE_INTEGER);
export function safeMoney(value: bigint): number {
  if (value < 0n || value > MAX_SAFE_MONEY) throw new RangeError('Unsupported monetary amount');
  return Number(value);
}
export function databaseMoney(value: string): number {
  if (!/^\d+$/.test(value)) throw new RangeError('Invalid stored monetary amount');
  return safeMoney(BigInt(value));
}
