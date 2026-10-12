import type { RequestHandler } from 'express';
import type { TokenVerifier } from '@ecommerce/security';
export function authenticate(verify: TokenVerifier): RequestHandler {
  return async (req, res, next) => {
    res.locals.userId = (await verify(req.headers.authorization)).id.toLowerCase();
    res.locals.authorization = req.headers.authorization;
    next();
  };
}
