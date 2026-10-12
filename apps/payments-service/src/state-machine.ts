import type { PaymentStatus } from './payment-repository.js';
import { PaymentError } from './errors.js';
const transitions: Record<PaymentStatus, readonly PaymentStatus[]> = {
 CREATED:['PROCESSING'], PROCESSING:['SUCCEEDED','FAILED','REQUIRES_RECONCILIATION'],
 REQUIRES_RECONCILIATION:['SUCCEEDED','FAILED'], SUCCEEDED:[], FAILED:[],
};
export function assertTransition(from: PaymentStatus,to: PaymentStatus): void {
 // Unknown reconciliation leaves the same persisted state; it is not a new charge attempt.
 if (from === 'REQUIRES_RECONCILIATION' && to === from) return;
 if (!transitions[from].includes(to)) throw new PaymentError(409,'Invalid payment state transition');
}
