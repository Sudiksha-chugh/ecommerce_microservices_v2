// Explicit isolated diagnostic exercise; never reads a service repository or activates checkout.
import {readFile} from 'node:fs/promises';
import {parseEnv} from 'node:util';
import {randomUUID} from 'node:crypto';
import amqp from 'amqplib';
import {Messaging,names,queueSpecs,type Event} from './index.js';
const env=parseEnv(await readFile('.env.messaging','utf8'));
const namespace=`test_demo_${randomUUID().replaceAll('-','')}`;
const url=`amqp://commerce_test:${encodeURIComponent(env.RABBITMQ_TEST_PASSWORD!)}@127.0.0.1:${env.RABBITMQ_AMQP_PORT??5673}/commerce_test`;
const m=new Messaging({url,namespace},['orders','inventory','payments']);let consumed=0;
for(const spec of queueSpecs)m.register(spec.name,async () => {consumed++;});
const now=new Date().toISOString(),orderId=randomUUID(),correlationId=randomUUID(),items=[{productId:randomUUID(),quantity:2}];
const events:Event[]=[
 {eventId:randomUUID(),eventType:'order.created',eventVersion:1,occurredAt:now,producer:'orders-service',correlationId,causationId:null,payload:{orderId,userId:randomUUID(),totalAmountPaise:50000,currency:'INR',items,createdAt:now}},
 {eventId:randomUUID(),eventType:'inventory.reserved',eventVersion:1,occurredAt:now,producer:'inventory-service',correlationId,causationId:null,payload:{orderId,items,expiresAt:new Date(Date.now()+900000).toISOString()}},
 {eventId:randomUUID(),eventType:'payment.succeeded',eventVersion:1,occurredAt:now,producer:'payments-service',correlationId,causationId:null,payload:{orderId,paymentId:randomUUID(),amountPaise:50000,currency:'INR',succeededAt:now}},
];
async function until(condition:() => boolean){const deadline=Date.now()+60000;while(!condition()){if(Date.now()>deadline)throw new Error('Messaging diagnostic deadline exceeded');await new Promise((resolve) => setTimeout(resolve,25));}}
try {m.start();await until(() => m.status==='ready');for(const event of events)await m.publish(event);await until(() => consumed===4);console.info(JSON.stringify({outcome:'diagnostic_complete',published:3,consumed,namespace,correlationId}));}
finally {await m.stop();const connection=await amqp.connect(url);const channel=await connection.createChannel();for(const spec of queueSpecs){const n=names(namespace,spec);for(const queue of [n.queue,n.dlq,...[1,2,3].map((i) => `${n.queue}.retry.${i}`)])await channel.deleteQueue(queue);}for(const owner of ['orders','inventory','payments'])await channel.deleteExchange(`${namespace}.commerce.${owner}.handoff`);await channel.deleteExchange(`${namespace}.commerce.events`);await connection.close();}
