import { importPKCS8, SignJWT } from 'jose';
import type { PublicUser } from '@ecommerce/contracts';
import { createTokenVerifier, type JwtSettings } from '@ecommerce/security';

export async function createTokenService(privatePem: string, publicPem: string, settings: JwtSettings, ttlSeconds: number) {
  const key = await importPKCS8(privatePem, 'RS256');
  const verify = await createTokenVerifier(publicPem, settings);
  const sign = (user: Pick<PublicUser, 'id' | 'role'>) => new SignJWT({ role: user.role })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setSubject(user.id).setIssuer(settings.issuer).setAudience(settings.audience)
    .setIssuedAt().setExpirationTime(`${ttlSeconds}s`).sign(key);
  // Fail startup if the configured public/private keys do not match.
  await verify(`Bearer ${await sign({ id: '00000000-0000-4000-8000-000000000000', role: 'customer' })}`);
  return { sign, verify, ttlSeconds };
}
export type TokenService = Awaited<ReturnType<typeof createTokenService>>;
