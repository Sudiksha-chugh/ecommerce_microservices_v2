import type { RequestHandler } from 'express';
import type { TokenVerifier } from '@ecommerce/security';

export function requireAdmin(verify: TokenVerifier): RequestHandler {
  return async (req, res, next) => {
    try {
      const identity = await verify(req.headers.authorization);
      if (identity.role !== 'admin') {
        res.status(403).json({ error: { message: 'Forbidden' } }); return;
      }
      next();
    } catch {
      res.set('WWW-Authenticate', 'Bearer').status(401).json({ error: { message: 'Unauthorized' } });
    }
  };
}
