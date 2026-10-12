import type { RequestHandler } from 'express';
import type { TokenVerifier } from '@ecommerce/security';

export function authenticate(verify: TokenVerifier): RequestHandler {
  return async (request, response, next) => {
    response.locals.userId = (await verify(request.headers.authorization)).id.toLowerCase();
    next();
  };
}
