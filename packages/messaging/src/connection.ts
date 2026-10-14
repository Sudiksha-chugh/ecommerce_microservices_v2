import amqp,{type ChannelModel,type ConfirmChannel,type Channel,type ConsumeMessage,type Options} from 'amqplib';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { deserialize,serialize,routingKey,validateEvent,type Event } from './contracts/envelope.js';
import { MessagingUnavailableError,PoisonMessageError,UnroutableMessageError } from './errors.js';
import { backoff,classification,RETRY_DELAYS,retryable,retryCount } from './retry.js';
import { declareTopology,names,queueSpecs,type Service } from './topology.js';
export const messagingSettings=z.object({url:z.url().refine((v) => {const u=new URL(v);return ['amqp:','amqps:'].includes(u.protocol)&&!!u.username&&u.username!=='guest'&&!!u.password;},'Require application credentials'),namespace:z.string().max(64).regex(/^[a-zA-Z0-9_-]*$/).default(''),handlerTimeoutMs:z.number().int().min(50).max(120000).default(30000),prefetch:z.number().int().min(1).max(100).default(5),maxPending:z.number().int().min(1).max(1000).default(100),setupTimeoutMs:z.number().int().min(100).max(120000).default(30000),confirmTimeoutMs:z.number().int().min(50).max(60000).default(5000),connectTimeoutMs:z.number().int().min(50).max(30000).default(2000),reconnectBaseMs:z.number().int().min(50).max(10000).default(250),reconnectMaxMs:z.number().int().min(50).max(60000).default(30000),queues:z.array(z.enum(queueSpecs.map(s=>s.name))).nonempty().max(queueSpecs.length).optional(),shutdownTimeoutMs:z.number().int().min(50).max(60000).default(10000),retryDelays:z.array(z.number().int().min(1).max(300000)).length(3).default([...RETRY_DELAYS])}).refine((config) => config.reconnectMaxMs>=config.reconnectBaseMs,'Reconnect cap must be at least the base delay');
export type Settings=z.input<typeof messagingSettings>;
export type EventHandler=(event:Event,context:{retryCount:number;redelivered:boolean;signal:AbortSignal}) => Promise<void>;
type Spec=(typeof queueSpecs)[number];
interface Session {connection:ChannelModel;publisher:ConfirmChannel;channels:Array<{channel:Channel;tag:string}>;controller:AbortController;started:number;ready:boolean;gate:Promise<void>;release:() => void}
interface Pending {reject:(error:Error) => void;returned:boolean;timer:ReturnType<typeof setTimeout>}
export class Messaging {
 private readonly config:z.infer<typeof messagingSettings>;
 private session:Session|undefined;private lastFailure:'TRANSIENT'|'CONFIGURATION'='TRANSIENT';private stopped=false;private started=false;private timer:ReturnType<typeof setTimeout>|undefined;private openingConnection:ChannelModel|undefined;private connecting=false;private connectingTask:Promise<void>|undefined;private stopping:Promise<void>|undefined;private attempt=0;
 private readonly registrations=new Map<string,{spec:Spec;handler:EventHandler}>();private readonly active=new Set<Promise<void>>();private readonly pending=new Map<string,Pending>();
 readonly counters={published:0,consumed:0,failed:0,retried:0,deadLettered:0,reconnections:0};
 constructor(settings:Settings,private readonly services:readonly Service[],private readonly log:(record:Record<string,unknown>) => void=(record) => console.info(JSON.stringify(record))) {this.config=messagingSettings.parse(settings);}
 get status(){return this.stopped?'closed':this.session?.ready?'ready':this.started?'reconnecting':'idle';}
 register(queue:Spec['name'],handler:EventHandler){if(this.started)throw new Error('Register consumers before start');const spec=queueSpecs.find((s) => s.name===queue);if(!spec||!this.services.includes(spec.owner)||(this.config.queues&&!this.config.queues.includes(queue))||this.registrations.has(queue))throw new Error('Invalid or duplicate consumer registration');this.registrations.set(queue,{spec,handler});}
 start(){if(this.started)return;this.started=true;this.connectingTask=this.connect();}
 private classifyConnectionError(error:unknown){if(typeof error==='object'&&error!==null){const value=error as {code?:unknown;message?:unknown};if(new Set<unknown>([403,406,530,'ACCESS_REFUSED','PRECONDITION_FAILED']).has(value.code)||typeof value.message==='string'&&/ACCESS_REFUSED|PRECONDITION_FAILED|NOT_ALLOWED/.test(value.message))this.lastFailure='CONFIGURATION';}}
 private emit(outcome:string,extra:Record<string,unknown>={}){try {this.log({component:'messaging',outcome,...extra});}catch {/* Logging must not affect message disposition. */}}
 private schedule(){if(this.stopped||this.timer!==undefined)return;const delay=backoff(this.attempt++,this.config.reconnectBaseMs,this.config.reconnectMaxMs);this.timer=setTimeout(() => {this.timer=undefined;if(this.connecting){this.schedule();return;}this.connectingTask=this.connect();},delay);this.timer.unref();}
 private invalidate(session:Session){if(this.session!==session)return;this.session=undefined;session.controller.abort();session.release();for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new MessagingUnavailableError(this.lastFailure));}this.pending.clear();this.emit('connection_lost');if(Date.now()-session.started>30000)this.attempt=0;void session.connection.close().catch(() => {});this.schedule();}
 private async connect(){if(this.stopped||this.connecting||this.session)return;this.connecting=true;let connection:ChannelModel|undefined;let setupTimer:ReturnType<typeof setTimeout>|undefined;
  try {
   this.counters.reconnections++;this.emit('reconnection_attempt',{attempt:this.attempt});
   const origin=new URL(this.config.url);origin.searchParams.set('heartbeat','5');
   connection=await amqp.connect(origin.toString(),{timeout:this.config.connectTimeoutMs});
   if(this.stopped){connection.on('error',()=>{});(connection.connection as typeof connection.connection & {stream:import('node:net').Socket}).stream.destroy(new Error('Messaging stopped during connection setup'));return;}
   this.openingConnection=connection;const opening=connection;setupTimer=setTimeout(() => {void opening.close().catch(() => {});},this.config.setupTimeoutMs);
   connection.on('error',(error:unknown) => {this.classifyConnectionError(error);});let session:Session|undefined;let closed=false;
   connection.on('close',() => {closed=true;if(session)this.invalidate(session);});
   const publisher=await connection.createConfirmChannel();publisher.on('error',(error:unknown) => {this.classifyConnectionError(error);});publisher.on('close',() => {closed=true;if(session)this.invalidate(session);});
   publisher.on('return',(message:ConsumeMessage) => {const id=message.properties.headers?.['publication-id'];if(typeof id==='string'){const pending=this.pending.get(id);if(pending)pending.returned=true;}});
   await declareTopology(publisher,this.config.namespace,this.services,this.config.retryDelays,this.config.queues);
   let release=() => {};const gate=new Promise<void>((resolve) => {release=resolve;});
   session={connection,publisher,channels:[],controller:new AbortController(),started:Date.now(),ready:false,gate,release};this.session=session;
   // Register before announcing readiness; handlers yield to the event loop after setup finishes.
   for(const [consumer,{spec,handler}] of this.registrations){
    const channel=await connection.createChannel();channel.on('error',(error:unknown) => {this.classifyConnectionError(error);});channel.on('close',() => {closed=true;if(session)this.invalidate(session);});await channel.prefetch(this.config.prefetch);
    const current=session;const registered=await channel.consume(names(this.config.namespace,spec).queue,(message) => {
     if(!message){this.invalidate(current);return;}
     const work=this.consume(current,channel,message,spec,consumer,handler).catch(() => {this.invalidate(current);}).finally(() => this.active.delete(work));this.active.add(work);
    },{noAck:false});session.channels.push({channel,tag:registered.consumerTag});
   }
   if(this.stopped||closed){session.controller.abort();session.release();if(this.session===session)this.session=undefined;await connection.close().catch(() => {});if(!this.stopped)this.schedule();return;}
   this.lastFailure='TRANSIENT';session.ready=true;session.release();this.emit('connected');
  }catch(error) {this.classifyConnectionError(error);const failed=this.session;if(failed&&failed.connection===connection){failed.controller.abort();failed.release();this.session=undefined;}if(connection)await connection.close().catch(() => {});this.emit('connection_failed');this.schedule();}
  finally {clearTimeout(setupTimer);this.openingConnection=undefined;this.connecting=false;}
 }
 private send(session:Session,exchange:string,key:string,bytes:Buffer,properties:Options.Publish):Promise<void>{
  if(this.session!==session||!session.ready||this.stopped||this.pending.size>=this.config.maxPending)return Promise.reject(new MessagingUnavailableError(this.lastFailure));
  const id=randomUUID();return new Promise<void>((resolve,reject) => {
   const timer=setTimeout(() => {this.invalidate(session);},this.config.confirmTimeoutMs);
   const pending:Pending={reject,returned:false,timer};this.pending.set(id,pending);
   try {session.publisher.publish(exchange,key,bytes,{...properties,persistent:true,mandatory:true,headers:{...properties.headers,'publication-id':id}},(error:unknown) => {
    if(!this.pending.delete(id))return;clearTimeout(timer);
    if(error){reject(new MessagingUnavailableError(this.lastFailure));this.invalidate(session);}else if(pending.returned)reject(new UnroutableMessageError());else resolve();
   });}catch {this.pending.delete(id);clearTimeout(timer);reject(new MessagingUnavailableError(this.lastFailure));this.invalidate(session);}
  });
 }
 async publish(event:Event){event=validateEvent(event);const bytes=serialize(event);if(bytes.length>100000)throw new PoisonMessageError('MESSAGE_TOO_LARGE');const session=this.session;if(!session)throw new MessagingUnavailableError(this.lastFailure);await this.send(session,this.config.namespace?`${this.config.namespace}.commerce.events`:'commerce.events',routingKey(event),bytes,{contentType:'application/json',messageId:event.eventId,correlationId:event.correlationId,type:routingKey(event),timestamp:Math.max(0,Math.floor(Date.parse(event.occurredAt)/1000))});this.counters.published++;this.emit('published',{eventId:event.eventId,eventType:event.eventType,eventVersion:event.eventVersion,correlationId:event.correlationId});}
 async replay(queue:Spec['name'],event:Event){event=validateEvent(event);const spec=queueSpecs.find((value) => value.name===queue);if(!spec||!this.services.includes(spec.owner))throw new Error('Invalid replay queue');const bytes=serialize(event);const session=this.session;if(!session)throw new MessagingUnavailableError(this.lastFailure);await this.send(session,names(this.config.namespace,spec).handoff,`${spec.name}.deliver`,bytes,{contentType:'application/json',messageId:event.eventId,correlationId:event.correlationId,type:routingKey(event),headers:{'retry-count':0,'manual-replay':true}});}
 private async consume(session:Session,channel:Channel,message:ConsumeMessage,spec:Spec,consumer:string,handler:EventHandler){
  await session.gate;if(this.stopped||this.session!==session||session.controller.signal.aborted)return;
  const began=Date.now();let event:Event|undefined;let count=0;const metadata=() => ({eventId:event?.eventId,eventType:event?.eventType,eventVersion:event?.eventVersion,correlationId:event?.correlationId,queue:names(this.config.namespace,spec).queue,consumer,retryCount:count,processingDurationMs:Date.now()-began});
  try {
   count=retryCount(message.properties.headers,this.config.retryDelays.length);event=deserialize(message.content);
   if(!spec.bindings.some((binding) => binding.split('.').length===routingKey(event!).split('.').length && binding.split('.').every((part,index)=>part==='*'||part===routingKey(event!).split('.')[index])))throw new PoisonMessageError('UNEXPECTED_ROUTE');
   const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;let abort=() => {};
   const interrupted=new Promise<never>((_resolve,reject) => {abort=() => {controller.abort();reject(new Error('Handler interrupted'));};session.controller.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,this.config.handlerTimeoutMs);});
   try {await Promise.race([handler(event,{retryCount:count,redelivered:message.fields.redelivered,signal:controller.signal}),interrupted]);}
   finally {clearTimeout(timer);session.controller.signal.removeEventListener('abort',abort);}

   if(this.session===session&&!session.controller.signal.aborted){channel.ack(message);this.counters.consumed++;this.emit('acknowledged',metadata());}
  }catch(error){
   this.counters.failed++;const code=classification(error),retry=retryable(error)&&count<this.config.retryDelays.length;
   if(this.session!==session||session.controller.signal.aborted)return;
   const target=retry?`${spec.name}.retry.${count+1}`:`${spec.name}.dead`;
   // Copy body exactly, never assign a new logical event ID or trust unbounded headers.
   try {await this.send(session,names(this.config.namespace,spec).handoff,target,message.content,{contentType:message.properties.contentType??'application/json',...(event?{messageId:event.eventId,correlationId:event.correlationId,type:routingKey(event)}:{}),headers:{'retry-count':retry?count+1:count,'failure-classification':code,'source-queue':names(this.config.namespace,spec).queue}});
    if(this.session===session&&!session.controller.signal.aborted){channel.ack(message);if(retry)this.counters.retried++;else this.counters.deadLettered++;this.emit(retry?'retry_handoff':'dead_letter_handoff',{...metadata(),failureClassification:code});}
   }catch {this.emit('handoff_failed',metadata());this.invalidate(session);}
  }
 }
 stop(){this.stopping??=this.shutdown();return this.stopping;}
 private async shutdown(){
  if(this.stopped)return;this.stopped=true;clearTimeout(this.timer);
  const connections=new Set<ChannelModel>();if(this.openingConnection)connections.add(this.openingConnection);if(this.session)connections.add(this.session.connection);
  let phase='stop_connecting',timer:ReturnType<typeof setTimeout>|undefined;
  const emit=()=>this.emit('shutdown_stage',{phase,activeHandlers:this.active.size,pendingConfirms:this.pending.size});
  const retire=()=>{const session=this.session;this.session=undefined;session?.controller.abort();session?.release();for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new MessagingUnavailableError(this.lastFailure));}this.pending.clear();};
  // Cancellation and protocol close need the same finite budget as handler drain.
  // On expiry, transport loss requeues unfinished manual-ACK deliveries; never ACK them.
  const deadline=new Promise<void>(resolve=>{timer=setTimeout(()=>{
   this.emit('shutdown_deadline',{phase,activeHandlers:this.active.size,pendingConfirms:this.pending.size});retire();
   for(const connection of connections)(connection.connection as typeof connection.connection & {stream:import('node:net').Socket}).stream.destroy(new Error('Messaging shutdown deadline'));
   resolve();
  },this.config.shutdownTimeoutMs);});
  const graceful=(async()=>{
   emit();if(this.openingConnection)await this.openingConnection.close().catch(()=>{});await this.connectingTask;
   const session=this.session;if(!session)return;connections.add(session.connection);
   phase='cancel_consumers';emit();await Promise.allSettled(session.channels.map(({channel,tag})=>channel.cancel(tag)));
   phase='drain_handlers';emit();await Promise.allSettled([...this.active]);
   retire();phase='close_connection';emit();await session.connection.close().catch(()=>{});
  })();
  try{await Promise.race([graceful,deadline]);}finally{clearTimeout(timer);}
  this.emit('closed');
 }
}
