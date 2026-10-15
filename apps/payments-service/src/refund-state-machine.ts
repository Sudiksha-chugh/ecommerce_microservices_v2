export const refundTransitions={REQUESTED:['PROCESSING'],PROCESSING:['SUCCEEDED','FAILED','REQUIRES_RECONCILIATION'],REQUIRES_RECONCILIATION:['REQUIRES_RECONCILIATION','SUCCEEDED','FAILED','MANUAL_REVIEW_REQUIRED'],MANUAL_REVIEW_REQUIRED:['SUCCEEDED','FAILED','MANUAL_REVIEW_REQUIRED'],SUCCEEDED:[],FAILED:[]} as const;
export type RefundStatus=keyof typeof refundTransitions;
export function assertRefundTransition(from:RefundStatus,to:RefundStatus){if(!(refundTransitions[from] as readonly string[]).includes(to))throw new Error('Invalid refund transition');}
