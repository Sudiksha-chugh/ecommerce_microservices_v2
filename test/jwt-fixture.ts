import { exportPKCS8, exportSPKI, generateKeyPair, SignJWT } from 'jose';
import { createTokenVerifier } from '@ecommerce/security';

export async function createJwtFixture() {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
  const privatePem = await exportPKCS8(privateKey);
  const publicPem = await exportSPKI(publicKey);
  const settings = { issuer: 'test-auth', audience: 'test-api' };
  const verify = await createTokenVerifier(publicPem, settings);
  const sign = (role: 'admin' | 'customer' = 'admin', overrides: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: '00000000-0000-4000-8000-000000000000', role,
      iss: settings.issuer, aud: settings.audience, iat: now, exp: now + 900, ...overrides,
    }).setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).sign(privateKey);
  };
  return { privatePem, publicPem, settings, verify, sign };
}
