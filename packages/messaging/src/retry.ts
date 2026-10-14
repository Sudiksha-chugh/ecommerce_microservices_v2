import { PermanentHandlerError,PoisonMessageError } from './errors.js';
export const RETRY_DELAYS=[5000,30000,120000] as const;
export function retryCount(headers:Record<string,unknown>|undefined,max=3):number {
 const value=headers && Object.hasOwn(headers,'retry-count') ? headers['retry-count'] : 0;
 if(typeof value!=='number'||!Number.isInteger(value)||value<0||value>max)throw new PoisonMessageError('INVALID_RETRY_COUNT');
 return value;
}
export function classification(error:unknown) {return error instanceof PoisonMessageError?error.code:error instanceof PermanentHandlerError?'PERMANENT_HANDLER_FAILURE':'TRANSIENT_HANDLER_FAILURE';}
export function retryable(error:unknown) {return !(error instanceof PoisonMessageError||error instanceof PermanentHandlerError);}
export function backoff(attempt:number,base:number,cap:number,random=Math.random) {const ceiling=Math.min(cap,base*2**Math.min(attempt,20));return Math.max(base,Math.floor(ceiling*(0.5+random()*0.5)));}
