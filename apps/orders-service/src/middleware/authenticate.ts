import type { RequestHandler } from 'express';
import type { TokenVerifier } from '@ecommerce/security';
export function authenticate(verify: TokenVerifier): RequestHandler {
  return async (req, res, next) => {
    const identity=await verify(req.headers.authorization);res.locals.identity=identity;
    res.locals.userId = identity.id.toLowerCase();
    res.locals.authorization = req.headers.authorization;
    next();
  };
}
