import type { UserRepository } from './user-repository.js';
import type { Credentials } from './user-validation.js';
import { hashPassword } from './auth-service.js';
import { AuthError } from './errors.js';

// CLI-only: no route imports this function. Never silently promote or reset accounts.
export async function bootstrapAdmin(users: UserRepository, input: Credentials, nodeEnvironment: string): Promise<boolean> {
  if (nodeEnvironment === 'production') throw new Error('Local admin bootstrap disabled in production');
  try {
    await users.create(input.email, await hashPassword(input.password), 'admin');
    return true;
  } catch (error) {
    if (!(error instanceof AuthError) || error.status !== 409) throw error;
    const existing = await users.findByEmail(input.email);
    if (existing?.role !== 'admin') throw new Error('Existing customer cannot be promoted by bootstrap');
    return false;
  }
}
