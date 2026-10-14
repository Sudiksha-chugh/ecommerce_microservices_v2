export class OrderError extends Error {
  constructor(public readonly status: 404 | 409 | 422 | 502 | 503 | 504, message: string) { super(message); }
}
export class OrderDatabaseError extends Error {
  constructor() { super('Internal server error'); }
}
