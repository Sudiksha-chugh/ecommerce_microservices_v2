import type { Channel } from 'amqplib';
import { RETRY_DELAYS } from './retry.js';
export type Service='orders'|'inventory'|'payments'|'notifications'|'catalog'|'search';
export const queueSpecs=[
 {name:'inventory.order-created.v1',owner:'inventory',bindings:['order.created.v1']},
 {name:'payments.order-created.v1',owner:'payments',bindings:['order.created.v1']},
 {name:'orders.inventory-events.v1',owner:'orders',bindings:['inventory.*.v1']},
 {name:'orders.payment-events.v1',owner:'orders',bindings:['payment.*.v1']},
 {name:'inventory.checkout-commands.v1',owner:'inventory',bindings:['inventory.reserve.requested.v1','inventory.confirm.requested.v1','inventory.release.requested.v1']},
 {name:'payments.checkout-commands.v1',owner:'payments',bindings:['payment.process.requested.v1']},
 {name:'orders.checkout-events.v1',owner:'orders',bindings:['checkout.inventory.*.v1','checkout.payment.*.v1']},
 {name:'payments.refund-commands.v1',owner:'payments',bindings:['payment.refund.requested.v1']},
 {name:'orders.refund-events.v1',owner:'orders',bindings:['payment.refund_succeeded.v1','payment.refund_failed.v1','payment.refund_reconciliation_required.v1']},
 {name:'inventory.compensation-commands.v1',owner:'inventory',bindings:['inventory.compensate.requested.v1']},
 {name:'notifications.business-events.v1',owner:'notifications',bindings:['order.confirmed.v1','order.cancelled.v1','checkout.payment.succeeded.v1','checkout.payment.failed.v1','payment.refund_succeeded.v1','payment.refund_failed.v1','payment.refund_reconciliation_required.v1']},
 {name:'search.product-events.v1',owner:'search',bindings:['catalog.product.created.v1','catalog.product.updated.v1','catalog.product.deleted.v1']},
] as const;
export function names(namespace:string,spec:(typeof queueSpecs)[number]) {const prefix=namespace?`${namespace}.`:'';return {queue:prefix+spec.name,dlq:prefix+spec.name.replace(/\.v1$/,'.dlq'),handoff:`${prefix}commerce.${spec.owner}.handoff`,events:`${prefix}commerce.events`};}
export async function declareTopology(channel:Channel,namespace='',services:readonly Service[]=['orders','inventory','payments'],delays:readonly number[]=RETRY_DELAYS,selected?:readonly (typeof queueSpecs)[number]['name'][]) {
 const exchange=namespace?`${namespace}.commerce.events`:'commerce.events';if(services.length===1&&['notifications','search','catalog'].includes(services[0]!))await channel.checkExchange(exchange);else await channel.assertExchange(exchange,'topic',{durable:true});
 for(const spec of queueSpecs.filter((spec) => services.includes(spec.owner)&&(!selected||selected.includes(spec.name)))) {
  const n=names(namespace,spec);await channel.assertExchange(n.handoff,'direct',{durable:true});
  const args={'x-queue-type':'quorum','x-overflow':'reject-publish','x-max-length':10000,'x-delivery-limit':-1};
  await channel.assertQueue(n.queue,{durable:true,arguments:args});
  for(const key of spec.bindings)await channel.bindQueue(n.queue,n.events,key);
  await channel.bindQueue(n.queue,n.handoff,`${spec.name}.deliver`);
  await channel.assertQueue(n.dlq,{durable:true,arguments:args});await channel.bindQueue(n.dlq,n.handoff,`${spec.name}.dead`);
  for(const [i,delay] of delays.entries()) {
   const queue=`${n.queue}.retry.${i+1}`;
   await channel.assertQueue(queue,{durable:true,arguments:{...args,'x-message-ttl':delay,'x-dead-letter-exchange':n.handoff,'x-dead-letter-routing-key':`${spec.name}.deliver`,'x-dead-letter-strategy':'at-least-once'}});
   await channel.bindQueue(queue,n.handoff,`${spec.name}.retry.${i+1}`);
  }
 }
}
