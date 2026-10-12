import type { ErrorRequestHandler } from 'express';
import { InvalidTokenError } from '@ecommerce/security';
import { CartError } from '../errors.js';

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) { next(error); return; }
  if (error instanceof InvalidTokenError) {
    res.set('WWW-Authenticate', 'Bearer').status(401).json({ error: { message: 'Unauthorized' } }); return;
  }
  if (error instanceof CartError) {
    res.status(error.status).json({ error: { message: error.message } }); return;
  }
  if (typeof error === 'object' && error !== null && 'type' in error) {
    if (error.type === 'entity.parse.failed') {
      res.status(400).json({ error: { message: 'Invalid JSON body' } }); return;
    }
    if (error.type === 'entity.too.large') {
      res.status(413).json({ error: { message: 'Request body too large' } }); return;
    }
  }
  console.error('Cart request failed');
  res.status(500).json({ error: { message: 'Internal server error' } });
};
