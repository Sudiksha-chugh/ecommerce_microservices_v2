import { importSPKI, jwtVerify } from 'jose';
import { z } from 'zod';

export interface JwtSettings { issuer: string; audience: string }
export interface Identity { id: string; role: 'customer' | 'admin' }
export type TokenVerifier = (authorization: string | undefined) => Promise<Identity>;
export class InvalidTokenError extends Error {
  constructor() { super('Unauthorized'); }
}
const claimsSchema = z.object({ sub: z.uuid(), role: z.enum(['customer', 'admin']) });

// This package only verifies; signing and private key access belong to Auth.
export async function createTokenVerifier(publicKeyPem: string, settings: JwtSettings): Promise<TokenVerifier> {
  const key = await importSPKI(publicKeyPem, 'RS256');
  return async (authorization) => {
    try {
      const token = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
      if (!token) throw new InvalidTokenError();
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['RS256'], issuer: settings.issuer, audience: settings.audience,
        requiredClaims: ['sub', 'role', 'iat', 'exp'],
      });
      const claims = claimsSchema.parse(payload);
      return { id: claims.sub, role: claims.role };
    } catch {
      throw new InvalidTokenError();
    }
  };
}

export * from './internal-service.js';
