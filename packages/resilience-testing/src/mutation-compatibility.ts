import {compatibility,type Contract,type Schema} from './compatibility.js';
export interface MutationExpectation extends Contract {idempotency:'principal-key'|'order-id'|'payment-id'|'refund-id'|'none';requestSchema:Schema;errorSchema:Schema;statuses:readonly number[];responseKind:'json'|'empty'}
export function mutationCompatibility(consumer:MutationExpectation,provider:MutationExpectation):string[]{
 const failures=compatibility(consumer,provider);
 for(const key of ['idempotency','responseKind'] as const)if(consumer[key]!==provider[key])failures.push(`metadata.${key}`);
 if(provider.statuses.some(s=>!consumer.statuses.includes(s)))failures.push('metadata.statuses');
 // Requests are contravariant: the provider must accept every consumer request.
 failures.push(...compatibility({...consumer,schema:provider.requestSchema},{...consumer,schema:consumer.requestSchema}).map(f=>`request.${f}`));
 failures.push(...compatibility({...consumer,schema:consumer.errorSchema},{...consumer,schema:provider.errorSchema}).map(f=>`error.${f}`));
 return failures.slice(0,100);
}
