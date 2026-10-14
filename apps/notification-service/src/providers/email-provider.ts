import type {EmailContent} from '../templates/email.js';
export interface EmailRequest {operationId:string;recipient:string;content:EmailContent}
export type DeliveryResult={status:'ACCEPTED';messageId:string}|{status:'NOT_ACCEPTED';classification:'TRANSIENT'|'PERMANENT';code:string}|{status:'UNKNOWN'};
export interface EmailProvider {readonly channel:'EMAIL';readonly capabilities:{idempotentSend:boolean;statusLookup:boolean};sendEmail(request:EmailRequest):Promise<DeliveryResult>;getDeliveryStatus(operationId:string):Promise<DeliveryResult>}
