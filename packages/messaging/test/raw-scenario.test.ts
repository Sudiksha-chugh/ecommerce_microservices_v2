import { EventEmitter } from 'node:events';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import { describe, it, expect, vi } from 'vitest';
vi.mock('../src/topology.js', async importOriginal => ({ ...await importOriginal<typeof import('../src/topology.js')>(), declareTopology: vi.fn(async () => {}) }));
import { rawScenario } from './raw-scenario.js';

function transport(trace: string[], failure?: Error) {
 const raw = Object.assign(new EventEmitter(), {
  deleteQueue: vi.fn(async (name: string) => { trace.push(`queue:${name}`); if (failure) throw failure; }),
  deleteExchange: vi.fn(async (name: string) => { trace.push(`exchange:${name}`); }),
  close: vi.fn(async () => { trace.push('channel:close'); raw.emit('close'); }),
 });
 const connection = Object.assign(new EventEmitter(), {
  createConfirmChannel: vi.fn(async () => raw as unknown as ConfirmChannel),
  close: vi.fn(async () => { trace.push('connection:close'); connection.emit('close'); }),
 });
 return { raw, connection, model: connection as unknown as ChannelModel };
}
const queues = ['inventory.order-created.v1'] as const;
describe('isolated raw broker scenarios', () => {
 it('uses independent connections/namespaces and removes only exact owned resources before closing', async () => {
  const trace: string[] = [], first = transport(trace), second = transport(trace);
  const connect = vi.fn().mockResolvedValueOnce(first.model).mockResolvedValueOnce(second.model);
  const a = await rawScenario('amqp://isolated', [...queues], [120,180,240], connect);
  const b = await rawScenario('amqp://isolated', [...queues], [120,180,240], connect);
  expect(a.namespace).not.toBe(b.namespace); expect(a.connection).not.toBe(b.connection);
  const closing = a.close(); expect(a.close()).toBe(closing); await closing;
  expect(trace.filter(item => /^(queue|exchange):/.test(item)).every(item => item.includes(a.namespace))).toBe(true);
  expect(trace.slice(-2)).toEqual(['channel:close','connection:close']);
  expect(second.connection.close).not.toHaveBeenCalled(); await b.close();
 });
 it('recovers exact cleanup after a closed transport and retains the original failure', async () => {
  const trace: string[] = [], error = new Error('Connection closed: ECONNRESET');
  const primary = transport(trace, error), recovery = transport(trace), next = transport(trace);
  const connect = vi.fn().mockResolvedValueOnce(primary.model).mockResolvedValueOnce(recovery.model).mockResolvedValueOnce(next.model);
  const scenario = await rawScenario('amqp://isolated', [...queues], [120], connect);
  primary.raw.emit('close'); primary.connection.emit('close');
  await expect(scenario.close()).rejects.toMatchObject({ errors: [error] });
  expect(recovery.raw.deleteQueue).toHaveBeenCalledTimes(3);
  expect(recovery.raw.deleteQueue.mock.calls.every(([name]) => name.startsWith(scenario.namespace+'.'))).toBe(true);
  expect(recovery.connection.close).toHaveBeenCalledOnce();
  const later = await rawScenario('amqp://isolated', [...queues], [120], connect);
  expect(later.connection).toBe(next.model); expect(later.namespace).not.toBe(scenario.namespace);
  await later.close();
 });
});
