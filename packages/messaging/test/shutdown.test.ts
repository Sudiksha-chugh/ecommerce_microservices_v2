import { EventEmitter } from 'node:events';
import amqp, { type ChannelModel, type ConsumeMessage } from 'amqplib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Messaging, serialize } from '../src/index.js';
import { fixture } from './fixture.js';

// Model AMQP protocol replies independently of the manager. Real TCP/broker recovery
// remains covered by rabbitmq.test.ts; these tests control the precise STOPPED race.
function broker() {
  const channel = Object.assign(new EventEmitter(), {
    assertExchange: vi.fn(async () => ({})), checkExchange: vi.fn(async () => ({})),
    assertQueue: vi.fn(async () => ({})), bindQueue: vi.fn(async () => ({})), prefetch: vi.fn(async () => ({})),
    consume: vi.fn(async (_queue: string, callback: (message: ConsumeMessage | null) => void) => { delivery = callback; return { consumerTag: 'controlled-consumer' }; }),
    cancel: vi.fn(async () => ({})), ack: vi.fn(),
  });
  let delivery: ((message: ConsumeMessage | null) => void) | undefined;
  const model = Object.assign(new EventEmitter(), {
    createConfirmChannel: vi.fn(async () => channel), createChannel: vi.fn(async () => channel),
    close: vi.fn(async () => { clearInterval(heartbeat); model.emit('close'); }),
    connection: { stream: { destroy: vi.fn((error?: Error) => {
      // amqplib cleans its heartbeat on error/end, not a bare local socket close.
      if (error) { clearInterval(heartbeat); model.emit('error', error); model.emit('close'); }
    }) } },
  });
  const heartbeat = setInterval(() => {}, 1000);
  const deliver = () => delivery?.({ content: serialize(fixture()), fields: { redelivered: false }, properties: { headers: {} } } as ConsumeMessage);
  return { model, channel, deliver };
}
const managers: Messaging[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  const stopping = Promise.all(managers.splice(0).map(manager => manager.stop()));
  await vi.advanceTimersByTimeAsync(100); await stopping;
  vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers();
});
function manager(handler?: () => Promise<void>) {
  const instance = new Messaging({ url: 'amqp://test:password@localhost/test', queues: ['inventory.order-created.v1'], shutdownTimeoutMs: 50, reconnectBaseMs: 50, reconnectMaxMs: 50 }, ['inventory'], () => {});
  if (handler) instance.register('inventory.order-created.v1', handler);
  managers.push(instance); return instance;
}
async function connected(handler?: () => Promise<void>) {
  const controlled = broker();
  const connect = vi.spyOn(amqp, 'connect').mockResolvedValue(controlled.model as unknown as ChannelModel);
  const instance = manager(handler); instance.start(); await vi.advanceTimersByTimeAsync(0);
  expect(instance.status).toBe('ready');
  return { ...controlled, instance, connect };
}
describe('Messaging STOPPED lifecycle', () => {
  it('closes a connected session and repeated stop calls share completion', async () => {
    const { instance, model, connect } = await connected(async () => {});
    const first = instance.stop(); expect(instance.stop()).toBe(first); await first;
    expect(model.close).toHaveBeenCalledOnce(); expect(instance.status).toBe('closed');
    await vi.advanceTimersByTimeAsync(1000); expect(connect).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('stops during reconnect and never starts a scheduled attempt afterward', async () => {
    const connect = vi.spyOn(amqp, 'connect').mockRejectedValue(new Error('controlled disconnect'));
    const instance = manager(); instance.start(); await vi.advanceTimersByTimeAsync(0);
    expect(instance.status).toBe('reconnecting'); await instance.stop();
    await vi.advanceTimersByTimeAsync(1000); expect(connect).toHaveBeenCalledOnce(); expect(instance.status).toBe('closed');
  });
  it('stops after a broker disconnect without recreating the session', async () => {
    const { instance, model, connect } = await connected();
    model.connection.stream.destroy(new Error('controlled broker loss'));
    expect(instance.status).toBe('reconnecting'); await instance.stop();
    await vi.advanceTimersByTimeAsync(1000); expect(connect).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('cleans transport and pending heartbeat when the close reply never arrives', async () => {
    const { instance, model, connect } = await connected();
    model.close.mockImplementation(() => new Promise<void>(() => {}));
    const stopped = instance.stop(); await vi.advanceTimersByTimeAsync(60); await stopped;
    expect(model.connection.stream.destroy).toHaveBeenCalledWith(expect.any(Error));
    await vi.advanceTimersByTimeAsync(1000); expect(connect).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not start or ACK a late delivery while cancellation is still pending', async () => {
    const handler = vi.fn(async () => {});
    const { instance, channel, deliver } = await connected(handler);
    channel.cancel.mockImplementation(() => new Promise(() => {}));
    const stopped = instance.stop(); deliver(); await vi.advanceTimersByTimeAsync(0);
    expect(handler).not.toHaveBeenCalled(); expect(channel.ack).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60); await stopped;
  });
  it('abandons an unfinished handler without ACK after the deadline', async () => {
    let release!: () => void;
    const handler = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const { instance, channel, deliver } = await connected(handler);
    deliver(); await vi.advanceTimersByTimeAsync(0); expect(handler).toHaveBeenCalledOnce();
    const stopped = instance.stop(); await vi.advanceTimersByTimeAsync(60); await stopped;
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(channel.ack).not.toHaveBeenCalled(); expect(instance.counters.consumed).toBe(0);
  });
  it('retires a connection that opens after shutdown completion', async () => {
    let open!: (model: ChannelModel) => void;
    vi.spyOn(amqp, 'connect').mockImplementation(() => new Promise(resolve => { open = resolve; }));
    const instance = manager(); instance.start(); const stopped = instance.stop();
    await vi.advanceTimersByTimeAsync(60); await stopped;
    const controlled = broker(); open(controlled.model as unknown as ChannelModel); await vi.advanceTimersByTimeAsync(0);
    expect(controlled.model.createConfirmChannel).not.toHaveBeenCalled();
    expect(controlled.model.connection.stream.destroy).toHaveBeenCalledWith(expect.any(Error));
    expect(instance.status).toBe('closed'); expect(vi.getTimerCount()).toBe(0);
  });
});
