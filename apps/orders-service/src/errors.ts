export class OrderError extends Error {
  constructor(public readonly status: 409 | 422 | 502 | 504, message: string) { super(message); }
}
export class OrderDatabaseError extends Error {
  constructor() { super('Internal server error'); }
}
