import {metrics} from '@opentelemetry/api';
import {enabled} from './context.js';
function createInstruments(){
const latency={unit:'s',advice:{explicitBucketBoundaries:[0.001,0.005,0.01,0.025,0.05,0.075,0.1,0.25,0.5,0.75,1,2.5,5,10]}};
const meter=metrics.getMeter('ecommerce.observability','0.1.0');
const httpDuration=meter.createHistogram('http.server.request.duration',latency),httpCount=meter.createCounter('http.server.requests'),httpErrors=meter.createCounter('http.server.errors');
const clientDuration=meter.createHistogram('http.client.request.duration',latency);
const dependency=meter.createHistogram('dependency.operation.duration',latency),messages=meter.createCounter('messaging.operations'),messageDuration=meter.createHistogram('messaging.process.duration',latency),business=meter.createCounter('business.observations'),rebuild=meter.createHistogram('search.rebuild.duration',{unit:'s',advice:{explicitBucketBoundaries:[1,5,10,30,60,120,300,600,900,1800]}});
return {httpDuration,httpCount,httpErrors,clientDuration,dependency,messages,messageDuration,business,rebuild};}
let cached:ReturnType<typeof createInstruments>|undefined;
const instruments=()=>cached??=createInstruments();
export function httpMetric(method:string,route:string,status:number,seconds:number){if(!enabled())return;try{const a={'http.request.method':method,'http.route':route,'http.response.status_code':status};instruments().httpCount.add(1,a);instruments().httpDuration.record(seconds,a);if(status>=500)instruments().httpErrors.add(1,a);}catch{}}
export function dependencyMetric(system:string,operation:string,outcome:'success'|'error',seconds:number){if(!enabled())return;try{instruments().dependency.record(seconds,{'db.system.name':system,'operation':operation,'outcome':outcome});}catch{}}
export function messagingMetric(operation:'publish'|'process'|'retry'|'dead_letter',outcome:'success'|'error',seconds=0){if(!enabled())return;try{instruments().messages.add(1,{operation,outcome});if(operation==='process')instruments().messageDuration.record(seconds,{outcome});}catch{}}
export type BusinessOperation='order_created'|'order_completed'|'order_failed'|'compensation_started'|'payment_attempt'|'payment_success'|'payment_failure'|'reconciliation_attempt'|'refund_outcome'|'reservation_attempt'|'reservation_success'|'reservation_failure'|'reservation_expired'|'compensation_outcome'|'search_projection'|'search_reconciliation'|'search_rebuild';
export function observeBusiness(operation:BusinessOperation,outcome:'success'|'error'|'observed'='observed'){if(!enabled())return;try{instruments().business.add(1,{operation,outcome});}catch{}}

export function httpClientMetric(method:string,outcome:'success'|'error',seconds:number){if(!enabled())return;try{instruments().clientDuration.record(seconds,{'http.request.method':method,outcome});}catch{}}

export function rebuildDuration(seconds:number,kind:string){if(!enabled())return;try{instruments().rebuild.record(seconds,{operation:kind==='RECONCILE'?'reconciliation':'rebuild'});}catch{}}
