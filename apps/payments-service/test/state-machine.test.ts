import { describe, expect, it } from 'vitest';
import { assertTransition } from '../src/state-machine.js';
import { intentSchema, keySchema } from '../src/validation.js';
describe('Payment state machine',() => {
 it.each([['CREATED','PROCESSING'],['PROCESSING','SUCCEEDED'],['PROCESSING','FAILED'],['PROCESSING','REQUIRES_RECONCILIATION'],['REQUIRES_RECONCILIATION','SUCCEEDED'],['REQUIRES_RECONCILIATION','FAILED'],['REQUIRES_RECONCILIATION','REQUIRES_RECONCILIATION']] as const)('allows %s to %s', (from,to) => {expect(() => assertTransition(from,to)).not.toThrow();});
 it.each([['SUCCEEDED','PROCESSING'],['SUCCEEDED','FAILED'],['SUCCEEDED','REQUIRES_RECONCILIATION'],['FAILED','PROCESSING'],['FAILED','SUCCEEDED'],['REQUIRES_RECONCILIATION','PROCESSING'],['CREATED','SUCCEEDED'],['CREATED','FAILED']] as const)('rejects %s to %s',(from,to) => {expect(() => assertTransition(from,to)).toThrow('Invalid payment state transition');});
 it('normalizes UUIDs before fingerprinting and rejects body-supplied simulation',() => {const id='AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';const value=intentSchema.parse({orderId:id,userId:id,amountPaise:1,currency:'INR'});expect(value.orderId).toBe(id.toLowerCase());expect(intentSchema.safeParse({...value,scenario:'success'}).success).toBe(false);});
 it('rejects keys with whitespace and control characters without silently trimming',() => {for(const key of [' key','key ','key\n','key\u0000'])expect(keySchema.safeParse(key).success).toBe(false);});
});
