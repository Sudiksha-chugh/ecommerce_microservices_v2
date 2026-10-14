// One-message, operator-invoked replay. Invalid contracts remain in the DLQ.
import amqp from 'amqplib';
import {Messaging,deserialize,names,queueSpecs,type Service} from './index.js';
const [owner,queue]=process.argv.slice(2);const spec=queueSpecs.find((s) => s.owner===owner&&s.name===queue);
if(!spec||!process.env.MESSAGING_URL)throw new Error('Use messaging:replay <service> <queue> with its MESSAGING_URL');
const url=process.env.MESSAGING_URL;const manager=new Messaging({url},[owner as Service]);const connection=await amqp.connect(url);connection.on('error',() => {});const channel=await connection.createChannel();channel.on('error',() => {});
try {manager.start();const deadline=Date.now()+10000;while(manager.status!=='ready'){if(Date.now()>deadline)throw new Error('Replay broker unavailable');await new Promise((resolve) => setTimeout(resolve,25));}
 const message=await channel.get(names('',spec).dlq,{noAck:false});if(!message)console.info('DLQ empty');else {const event=deserialize(message.content);await manager.replay(spec.name,event);channel.ack(message);console.info(JSON.stringify({outcome:'manual_replay',eventId:event.eventId,correlationId:event.correlationId,queue:spec.name}));}
}finally {await manager.stop();await connection.close();}
