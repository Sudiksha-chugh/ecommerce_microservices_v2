export class AuthError extends Error {
  constructor(public readonly status: 401 | 409, message: string) { super(message); }
}
export class DatabaseError extends Error {
  constructor() { super('Internal server error'); }
}
