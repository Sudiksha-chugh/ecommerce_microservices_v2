export class InventoryError extends Error {
  constructor(public readonly status: 404 | 409 | 502 | 504, message: string) { super(message); }
}
export class InventoryDatabaseError extends Error {
  constructor() { super('Internal server error'); }
}
