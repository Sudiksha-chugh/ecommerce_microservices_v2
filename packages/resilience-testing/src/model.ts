import {createHash,randomUUID} from 'node:crypto';
import { z } from 'zod';
export const targets = ['postgres','rabbitmq','redis','elasticsearch','orders','payments','inventory','consumer','outbox','network'] as const;
export const faults = ['unavailable','timeout','latency','connection_reset','terminate','delivery_delay','duplicate','reorder','restart','interrupt'] as const;
export const invariantIds = ['no-duplicate-effect','no-duplicate-payment','no-duplicate-refund','no-overselling','valid-saga-transition','no-lost-outbox','no-duplicate-confirmation','no-unauthorized-access','no-false-success','bounded-retries','eventual-recovery'] as const;
export const invariantSpec = z.strictObject({id:z.enum(invariantIds),kind:z.enum(['immediate','eventual','availability']),recoveryHorizonMs:z.number().int().min(0).max(300000)});
export const scenarioSchema = z.strictObject({
 id:z.string().regex(/^[a-z][a-z0-9-]{2,79}$/),description:z.string().min(1).max(1000),target:z.enum(targets),fault:z.enum(faults),
 injectionPoint:z.enum(['before-request','during-request','after-commit','before-publish','after-publish','before-ack','before-confirm','before-compensation']),
 preconditions:z.array(z.enum(['owned','healthy','seeded','committed'])).min(2).max(4).refine(v=>v.includes('owned')&&v.includes('healthy')&&new Set(v).size===v.length),
 maxDurationMs:z.number().int().min(10).max(300000),faultDurationMs:z.number().int().min(1).max(60000),
 recovery:z.literal('restore-owned-fixture'),cleanup:z.literal('remove-owned-fixture'),expectedBehavior:z.string().min(1).max(1000),
 invariants:z.array(invariantSpec).min(1).max(10).refine(v=>new Set(v.map(i=>i.id)).size===v.length),
}).refine(v=>v.faultDurationMs<=v.maxDurationMs&&v.invariants.every(i=>i.recoveryHorizonMs<=v.maxDurationMs),'Invalid scenario horizon');
export type Scenario=z.infer<typeof scenarioSchema>;
export const fixtureSchema=z.strictObject({runId:z.string().regex(/^[a-f0-9]{24}$/),project:z.string().regex(/^phase22-[a-f0-9]{24}$/),marker:z.literal('ecommerce-phase22'),resources:z.array(z.enum(targets)).min(1).max(10).refine(v=>new Set(v).size===v.length)}).refine(v=>v.project===`phase22-${v.runId}`);
export type Fixture=z.infer<typeof fixtureSchema>;
export const resourceSchema=z.strictObject({id:z.string().regex(/^[a-f0-9]{64}$/),kind:z.enum(['container','network','volume','process','server','channel']),target:z.enum(targets),labels:z.record(z.string(),z.string()),mounts:z.array(z.enum(['tmpfs','volume','bind'])).max(16)});
export type Resource=z.infer<typeof resourceSchema>;
const localReceipts=new WeakMap<object,{runId:string;target:string}>();
export function registerLocalResource(fixtureInput:unknown,target:Resource['target'],kind:'process'|'server'|'channel',handle:object):Resource {
 const fixture=fixtureSchema.parse(fixtureInput);if(!fixture.resources.includes(target))throw new Error('LOCAL_TARGET_REJECTED');
 if(!handle||typeof handle!=='object')throw new Error('LOCAL_HANDLE_REQUIRED');
 const resource:Resource={id:createHash('sha256').update(fixture.runId+randomUUID()).digest('hex'),kind,target,mounts:[],labels:{'io.ecommerce.phase22.owner':fixture.marker,'io.ecommerce.phase22.run':fixture.runId,'com.docker.compose.project':fixture.project,'io.ecommerce.phase22.target':target}};localReceipts.set(resource,{runId:fixture.runId,target});return resource;
}
export function verifyOwnership(fixtureInput:unknown,resourceInput:unknown):Resource {
 const fixture=fixtureSchema.parse(fixtureInput),resource=resourceSchema.parse(resourceInput),labels=resource.labels;
 if(['process','server','channel'].includes(resource.kind)){const receipt=typeof resourceInput==='object'&&resourceInput!==null?localReceipts.get(resourceInput):undefined;if(!receipt||receipt.runId!==fixture.runId||receipt.target!==resource.target)throw new Error('LOCAL_OWNERSHIP_REJECTED');}
 if(!fixture.resources.includes(resource.target)||labels['io.ecommerce.phase22.owner']!==fixture.marker||labels['io.ecommerce.phase22.run']!==fixture.runId||labels['com.docker.compose.project']!==fixture.project||labels['io.ecommerce.phase22.target']!==resource.target||resource.mounts.some(m=>m!=='tmpfs'))throw new Error('OWNERSHIP_REJECTED');
 return resource;
}
export const outcome=z.enum(['passed','failed','inconclusive']);
export const evidenceSchema=z.strictObject({observed:z.number().int().nonnegative(),limit:z.literal(0),complete:z.boolean(),elapsedMs:z.number().int().nonnegative().max(600000)});
export type Evidence=z.infer<typeof evidenceSchema>;
export const invariantResultSchema=invariantSpec.extend({status:outcome,evidence:evidenceSchema.nullable(),detail:z.enum(['assertion-satisfied','assertion-violated','missing-evidence','horizon-exceeded'])});
export function evaluate(spec:z.infer<typeof invariantSpec>,input:unknown):z.infer<typeof invariantResultSchema>{
 const parsed=evidenceSchema.safeParse(input);
 if(!parsed.success||!parsed.data.complete)return {...spec,status:'inconclusive',evidence:parsed.success?parsed.data:null,detail:'missing-evidence'};
 const evidence=parsed.data;
 if(spec.kind==='eventual'&&evidence.elapsedMs>spec.recoveryHorizonMs)return {...spec,status:'failed',evidence,detail:'horizon-exceeded'};
 const passed=evidence.observed<=evidence.limit;
 return {...spec,status:passed?'passed':'failed',evidence,detail:passed?'assertion-satisfied':'assertion-violated'};
}
export const stepSchema=z.strictObject({status:outcome,durationMs:z.number().int().nonnegative(),verified:z.boolean()});
export const reportSchema=z.strictObject({schemaVersion:z.literal(1),scenarioId:z.string().regex(/^[a-z][a-z0-9-]{2,79}$/),sourceRevision:z.string().regex(/^[a-f0-9]{40}$/),sourceDigest:z.string().regex(/^[a-f0-9]{64}$/),fixture:fixtureSchema,status:outcome,fault:z.strictObject({type:z.enum(faults),target:z.enum(targets)}),startedAt:z.iso.datetime(),endedAt:z.iso.datetime(),durationMs:z.number().int().nonnegative(),recovery:stepSchema,cleanup:stepSchema,invariants:z.array(invariantResultSchema).max(10),limitations:z.array(z.enum(['precondition-failed','execution-failed','deadline-exceeded','interrupted','recovery-failed','cleanup-failed','missing-evidence'])).max(8)}).refine(r=>Date.parse(r.endedAt)>=Date.parse(r.startedAt)&&r.fixture.resources.includes(r.fault.target),'Invalid report identity or chronology').refine(r=>r.status!=='passed'||(r.limitations.length===0&&r.invariants.length>0&&r.invariants.every(i=>i.status==='passed')&&r.recovery.status==='passed'&&r.recovery.verified&&r.cleanup.status==='passed'&&r.cleanup.verified),'Passed reports require complete evidence and verified lifecycle');
export type Report=z.infer<typeof reportSchema>;
export const liveReportSchema=z.strictObject({schemaVersion:z.literal(1),sourceRevision:z.string().regex(/^[a-f0-9]{40}$/),sourceDigest:z.string().regex(/^[a-f0-9]{64}$/),fixture:fixtureSchema,reports:z.array(reportSchema).max(4),checks:z.array(z.strictObject({id:z.enum(['postgres-order-outbox-atomic-rollback','postgres-order-concurrent-idempotency','inventory-last-unit-confirm-retry-release','rabbitmq-duplicate-redelivery-consumer-restart','outbox-confirm-before-mark-ambiguity-restart','elasticsearch-duplicate-and-stale-version','payment-ambiguous-success-concurrent-reconciliation','refund-ambiguous-success-restart-idempotency','checkout-inventory-process-crash-redelivery-compensation']),status:outcome,durationMs:z.number().int().nonnegative(),evidence:z.record(z.string().regex(/^[a-z][A-Za-z0-9]{0,79}$/),z.number().int().nonnegative()).refine(v=>Object.keys(v).length<=20)})).max(9),cleanup:z.strictObject({verified:z.boolean()}),status:outcome}).refine(r=>r.status!=='passed'||(r.cleanup.verified&&r.reports.length===4&&new Set(r.reports.map(s=>s.scenarioId)).size===4&&r.reports.every(s=>s.status==='passed')&&r.checks.length===9&&new Set(r.checks.map(c=>c.id)).size===9&&r.checks.every(c=>c.status==='passed'&&Object.keys(c.evidence).length>0)),'Complete live evidence required');
