export const notificationTransitions={
 PENDING:['PROCESSING','SUPPRESSED'],RETRY_SCHEDULED:['PROCESSING','SUPPRESSED'],
 PROCESSING:['SENT','RETRY_SCHEDULED','FAILED_PERMANENTLY','DELIVERY_UNKNOWN','MANUAL_REVIEW_REQUIRED','SUPPRESSED'],
 DELIVERY_UNKNOWN:['PROCESSING','SENT','RETRY_SCHEDULED','MANUAL_REVIEW_REQUIRED'],
 MANUAL_REVIEW_REQUIRED:['PROCESSING','DELIVERY_UNKNOWN'],FAILED_PERMANENTLY:['RETRY_SCHEDULED'],SUPPRESSED:[],SENT:[]
} as const;
export type NotificationStatus=keyof typeof notificationTransitions;
export type NotificationType='ORDER_CONFIRMED'|'ORDER_CANCELLED'|'PAYMENT_SUCCEEDED'|'PAYMENT_FAILED'|'REFUND_SUCCEEDED'|'REFUND_FAILED'|'REFUND_PENDING';
export function assertNotificationTransition(from:NotificationStatus,to:NotificationStatus){if(!(notificationTransitions[from] as readonly string[]).includes(to))throw new Error('Invalid notification transition');}
export function retryDelay(attempt:number,base=30000,jitter=0.5){if(!Number.isInteger(attempt)||attempt<1||!Number.isFinite(jitter)||jitter<0||jitter>1)throw new Error('Invalid retry parameters');const factors=[1,4,20,60];return Math.min(1800000,Math.floor(base*(factors[Math.min(attempt-1,3)]??60)*(0.9+0.2*jitter)));}
