import { describe, it, expect } from 'vitest';
import { closeScenario } from './cleanup-stack.js';
describe('Search scenario cleanup failure isolation', () => {
 it('restores fixture settings and mocks even when another owned cleanup fails', async () => {
  const trace: string[] = [], failed = new Error('Owned index delete deadline');
  const cleanup = [async () => { trace.push('restore-refresh-interval'); }, async () => { trace.push('delete-other-index'); throw failed; }];
  await expect(closeScenario(cleanup, () => { trace.push('restore-mocks'); })).rejects.toMatchObject({ errors: [failed] });
  expect(trace).toEqual(['delete-other-index','restore-refresh-interval','restore-mocks']); expect(cleanup).toEqual([]);
 });
 it('retains every cleanup failure and remains safe to call again', async () => {
  const first = new Error('child'), second = new Error('proxy'), third = new Error('mock');
  const cleanup = [async () => { throw first; }, async () => { throw second; }];
  await expect(closeScenario(cleanup, () => { throw third; })).rejects.toMatchObject({ errors: [second,first,third] });
  await expect(closeScenario(cleanup, () => {})).resolves.toBeUndefined();
 });
});
