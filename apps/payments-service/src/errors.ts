export class PaymentError extends Error { constructor(public readonly status: 400 | 404 | 409, message: string) { super(message); } }
export class PaymentDatabaseError extends Error { constructor() { super('Internal server error'); } }
