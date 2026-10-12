import { UpstreamRequestError } from '../upstream-client.js';
import type { ErrorRequestHandler } from 'express';
import type { ErrorResponse } from '@ecommerce/contracts';

export const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
    response.status(413).json({ error: { message: 'Request body too large' } });
    return;
  }
  if (error instanceof UpstreamRequestError) {
    const body: ErrorResponse = { error: { message: error.message } };
    response.status(error.status).json(body);
    return;
  }
  console.error('Unhandled request error:', error);
  const body: ErrorResponse = { error: { message: 'Internal server error' } };
  response.status(500).json(body);
};
