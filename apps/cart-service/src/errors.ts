export class CartError extends Error {
  constructor(public readonly status: 400 | 404 | 502 | 503 | 504, message: string) { super(message); }
}
