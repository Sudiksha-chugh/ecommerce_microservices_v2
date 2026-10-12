import { DatabaseUnavailableError, DatabaseOperationError } from '../product-repository.js';
import type { ErrorRequestHandler } from 'express';
import type { ErrorResponse } from '@ecommerce/contracts';

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (typeof error === 'object' && error !== null && 'type' in error) {
    if (error.type === 'entity.parse.failed') {
      response.status(400).json({ error: { message: 'Invalid JSON body' } });
      return;
    }
    if (error.type === 'entity.too.large') {
      response.status(413).json({ error: { message: 'Request body too large' } });
      return;
    }
  }
  if (error instanceof DatabaseOperationError) {
    response.status(500).json({ error: { message: 'Internal server error' } });
    return;
  }
  if (error instanceof DatabaseUnavailableError) {
    response.status(503).json({ error: { message: error.message } });
    return;
  }
  console.error('Unhandled request error:', error);
  const body: ErrorResponse = { error: { message: 'Internal server error' } };
  response.status(500).json(body);
};
