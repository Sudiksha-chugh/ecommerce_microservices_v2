import { randomUUID } from 'node:crypto';
import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import { declareTopology, names, queueSpecs } from '../src/index.js';

type Connect = (url: string, options: { timeout: number }) => Promise<ChannelModel>;
export async function rawScenario(url: string, queues: (typeof queueSpecs)[number]['name'][], delays: number[], connect: Connect = amqp.connect) {
 const namespace = `test_${randomUUID().replaceAll('-', '')}`;
 const connection = await connect(url, { timeout: 2000 });
 let connectionClosed = false, channelClosed = false, channel: ConfirmChannel | undefined;
 connection.on('error', () => {});
 connection.on('close', () => { connectionClosed = true; });
 const remove = async (raw: ConfirmChannel) => {
  for (const spec of queueSpecs.filter(spec => queues.includes(spec.name))) {
   const n = names(namespace, spec);
   for (const queue of [n.queue, n.dlq, ...delays.map((_, i) => `${n.queue}.retry.${i + 1}`)]) await raw.deleteQueue(queue);
  }
  for (const owner of ['orders', 'inventory', 'payments']) await raw.deleteExchange(`${namespace}.commerce.${owner}.handoff`);
  await raw.deleteExchange(`${namespace}.commerce.events`);
 };
 let closing: Promise<void> | undefined;
 const close = () => closing ??= (async () => {
  const errors: unknown[] = [];
  try {
   if (!channel) throw new Error('Raw scenario setup incomplete');
   await remove(channel);
  } catch (error) {
   errors.push(error);
   // Recover only the cleanup transport. Keep the original failure observable;
   // the next scenario creates an independent connection and exact namespace.
   let recovery: ChannelModel | undefined, raw: ConfirmChannel | undefined;
   try {
    recovery = await connect(url, { timeout: 2000 }); recovery.on('error', () => {});
    raw = await recovery.createConfirmChannel(); raw.on('error', () => {});
    await remove(raw);
   } catch (recoveryError) { errors.push(recoveryError); }
   finally {
    if (raw) try { await raw.close(); } catch (error) { errors.push(error); }
    if (recovery) try { await recovery.close(); } catch (error) { errors.push(error); }
   }
  } finally {
   if (channel && !channelClosed) try { await channel.close(); } catch (error) { errors.push(error); }
   if (!connectionClosed) try { await connection.close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Raw scenario cleanup failed');
 })();
 try {
  channel = await connection.createConfirmChannel(); channel.on('error', () => {});
  channel.on('close', () => { channelClosed = true; });
  await declareTopology(channel, namespace, undefined, delays, queues);
  return { namespace, connection, raw: channel, close };
 } catch (error) {
  try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Raw scenario setup and cleanup failed'); }
  throw error;
 }
}
