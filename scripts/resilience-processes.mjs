import {fork} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {bounded} from '../packages/resilience-testing/src/bounded.ts';
import {registerLocalResource,verifyOwnership} from '../packages/resilience-testing/src/index.ts';
const modes=['service','outbox','payment','refund','consumer','inventory'];
export class OwnedWorker {
 constructor(fixture,mode,ports,inspectDependencies){if(!modes.includes(mode))throw new Error('WORKER_MODE_REJECTED');this.fixture=fixture;this.mode=mode;this.ports=ports;this.inspectDependencies=inspectDependencies;this.handle={};this.resource=registerLocalResource(fixture,mode==='service'?'orders':mode==='inventory'?'inventory':(mode==='payment'||mode==='refund')?'payments':mode==='outbox'?'outbox':'consumer','process',this.handle);this.children=new Set();}
 async inspect(signal){await this.inspectDependencies(signal);verifyOwnership(this.fixture,this.resource);return this.resource;}
 async start(signal){await this.inspect(signal);if(this.child&&this.child.exitCode===null&&this.child.signalCode===null)throw new Error('WORKER_ALREADY_RUNNING');
  const child=fork(new URL('./resilience-worker.mjs',import.meta.url),[],{execArgv:['--import','tsx'],env:{PATH:process.env.PATH,PHASE22_PROJECT:this.fixture.project,PHASE22_PGPORT:String(this.ports.postgres),PHASE22_AMQPPORT:String(this.ports.rabbitmq),PHASE22_MODE:this.mode,PHASE22_PROVIDER:this.ports.provider??'',PHASE22_USER_ID:this.ports.userId??''},stdio:['ignore','ignore','pipe','ipc']});this.child=child;this.children.add(child);child.stderr.on('data',()=>{});this.exited=once(child,'exit');
  const ready=await bounded(signal,()=>new Promise((resolve,reject)=>{const onMessage=m=>{if(m?.ready){child.off('message',onMessage);resolve(m);}};child.on('message',onMessage);child.once('exit',()=>reject(new Error('WORKER_EARLY_EXIT')));child.once('error',reject);}));this.origin=ready.origin;this.authorization=ready.authorization;return ready;
 }
 async kill(signal){await this.inspect(signal);const child=this.child;if(!child||!this.children.has(child))throw new Error('FOREIGN_CHILD');if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await bounded(signal,()=>this.exited);}return true;}
 async run(payload,signal){await this.inspect(signal);const child=this.child;if(!child||!this.children.has(child)||!child.connected)throw new Error('FOREIGN_CHILD');const result=bounded(signal,()=>new Promise((resolve,reject)=>{const onMessage=m=>{if(m?.done){child.off('message',onMessage);resolve(m);}};child.on('message',onMessage);child.once('exit',()=>reject(new Error('WORKER_EXIT')));}));child.send({job:{...payload,recover:true}});return result;}
 async crash(payload,signal){await this.inspect(signal);if(!this.child||!this.children.has(this.child)||!this.child.connected)throw new Error('FOREIGN_CHILD');this.child.send({job:payload});const [code,termination]=await bounded(signal,()=>this.exited);if(termination!=='SIGKILL')throw new Error(`EXPECTED_TEST_CRASH:${code}`);return true;}
 async cleanup(signal){for(const child of this.children){await this.inspect(signal);if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await bounded(signal,()=>done);}}return [...this.children].every(c=>c.exitCode!==null||c.signalCode!==null);}
}
