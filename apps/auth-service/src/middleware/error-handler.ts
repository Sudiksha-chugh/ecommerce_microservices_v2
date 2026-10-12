import type { ErrorRequestHandler } from 'express';
import { InvalidTokenError } from '@ecommerce/security';
import { AuthError } from '../errors.js';

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (response.headersSent) { next(error); return; }
  if (error instanceof InvalidTokenError || error instanceof AuthError) {
    const status = error instanceof AuthError ? error.status : 401;
    if (status === 401) response.set('WWW-Authenticate', 'Bearer');
    response.status(status).json({ error: { message: error.message } });
    return;
  }
  if (typeof error === 'object' && error !== null && 'type' in error) {
    if (error.type === 'entity.parse.failed') {
      response.status(400).json({ error: { message: 'Invalid JSON body' } }); return;
    }
    if (error.type === 'entity.too.large') {
      response.status(413).json({ error: { message: 'Request body too large' } }); return;
    }
  }
  // Never log request bodies, hashes, tokens, or database errors.
  console.error('Auth request failed');
  response.status(500).json({ error: { message: 'Internal server error' } });
};
