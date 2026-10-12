import type { Pool } from 'pg';
import type { PublicUser } from '@ecommerce/contracts';
import { AuthError, DatabaseError } from './errors.js';
export interface StoredUser extends PublicUser { passwordHash: string }

export class UserRepository {
  constructor(private readonly pool: Pool) {}
  async create(email: string, passwordHash: string, role: PublicUser['role'] = 'customer'): Promise<PublicUser> {
    try {
      const result = await this.pool.query<PublicUser>(
        'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role',
        [email, passwordHash, role],
      );
      const user = result.rows[0];
      if (!user) throw new DatabaseError();
      return user;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505'
        && 'constraint' in error && error.constraint === 'users_email_lower_unique') {
        throw new AuthError(409, 'Email already registered');
      }
      throw new DatabaseError();
    }
  }
  async findByEmail(email: string): Promise<StoredUser | undefined> {
    try {
      return (await this.pool.query<StoredUser>(
        'SELECT id, email, role, password_hash AS "passwordHash" FROM users WHERE LOWER(email) = LOWER($1)', [email],
      )).rows[0];
    } catch { throw new DatabaseError(); }
  }
  async findById(id: string): Promise<PublicUser | undefined> {
    try {
      return (await this.pool.query<PublicUser>('SELECT id, email, role FROM users WHERE id = $1', [id])).rows[0];
    } catch { throw new DatabaseError(); }
  }
}
