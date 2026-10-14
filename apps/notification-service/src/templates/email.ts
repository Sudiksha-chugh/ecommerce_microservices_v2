import {z} from 'zod';
import type {NotificationType} from '../domain/state-machine.js';
export const templateData=z.strictObject({reference:z.string().min(1).max(100),amountPaise:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),currency:z.literal('INR').optional()});
export type TemplateData=z.infer<typeof templateData>;
export interface EmailContent {subject:string;text:string;html:string;version:number}
export function escapeHtml(value:string){return value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}
function amount(paise:number){const p=BigInt(paise);return `INR ${p/100n}.${String(p%100n).padStart(2,'0')}`;}
export function renderEmail(type:NotificationType,input:unknown,version=1):EmailContent{
 if(version!==1)throw new Error('Unsupported template version');const d=templateData.parse(input);
 if(['PAYMENT_SUCCEEDED','REFUND_SUCCEEDED'].includes(type)&&(!d.amountPaise||d.currency!=='INR'))throw new Error('Missing financial template data');
 const messages:Record<NotificationType,[string,string]>={
 ORDER_CONFIRMED:['Your order is confirmed',`Order ${d.reference} is confirmed. Your payment and inventory confirmation are complete.`],
 ORDER_CANCELLED:['Your order is cancelled',`Order ${d.reference} is cancelled. Any required compensation has completed.`],
 PAYMENT_SUCCEEDED:['Payment receipt',`Payment of ${d.amountPaise?amount(d.amountPaise):''} for order ${d.reference} was successful. This receipt records your payment; it does not confirm fulfillment.`],
 PAYMENT_FAILED:['Payment was not completed',`Payment for order ${d.reference} was not completed. Please check your order status before taking further action.`],
 REFUND_SUCCEEDED:['Your refund is complete',`A refund of ${d.amountPaise?amount(d.amountPaise):''} for order ${d.reference} has completed.`],
 REFUND_FAILED:['Your refund was not completed',`The requested refund for order ${d.reference} could not be completed. Please contact support. This message does not change your order or any earlier refunds.`],
 REFUND_PENDING:['An update on your refund',`Your refund for order ${d.reference} is under review. We will update you when its outcome is confirmed.`]
 };
 const [subject,text]=messages[type];return {subject,text,html:`<p>${escapeHtml(text)}</p>`,version:1};
}
