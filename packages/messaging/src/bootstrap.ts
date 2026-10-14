import { z } from 'zod';
import { Messaging,messagingSettings,type EventHandler } from './connection.js';
import { queueSpecs,type Service } from './topology.js';
import type { Event } from './contracts/envelope.js';
const envSchema=z.object({MESSAGING_ENABLED:z.enum(['true','false']).default('false'),MESSAGING_DIAGNOSTIC_CONSUMERS:z.enum(['true','false']).default('false'),MESSAGING_URL:z.string().optional(),MESSAGING_PREFETCH:z.coerce.number().int().min(1).max(100).default(5)});
export function bootstrapMessaging(service:Service,env:NodeJS.ProcessEnv=process.env,handlers:Partial<Record<(typeof queueSpecs)[number]['name'],EventHandler>>={},logger?: (record:Record<string,unknown>)=>void) {
 const settings=envSchema.safeParse(env);if(!settings.success)throw new Error('Invalid messaging bootstrap configuration');
 if(settings.data.MESSAGING_ENABLED==='false')return {readiness:() => 'disabled',publish:async (_event:Event) => {throw new Error('Messaging disabled');},stop:async () => {}};
 const parsed=messagingSettings.safeParse({url:settings.data.MESSAGING_URL,prefetch:settings.data.MESSAGING_PREFETCH});if(!parsed.success)throw new Error('Invalid messaging URL/settings');
 const manager=new Messaging(parsed.data,[service],logger);
 for(const spec of queueSpecs.filter((spec) => spec.owner===service)){const handler=handlers[spec.name];if(handler)manager.register(spec.name,handler);else if(settings.data.MESSAGING_DIAGNOSTIC_CONSUMERS==='true')manager.register(spec.name,async () => { /* Explicit diagnostics only. */ });}
 manager.start();return {readiness:() => manager.status,publish:(event:Event) => manager.publish(event),stop:() => manager.stop()};
}
