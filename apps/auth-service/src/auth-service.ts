import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import type { PublicUser } from '@ecommerce/contracts';
import type { TokenService } from './token-service.js';
import type { UserRepository } from './user-repository.js';
import type { Credentials } from './user-validation.js';
import { AuthError } from './errors.js';

export const hashPassword = (password: string) => argon2.hash(password, {
  type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1,
});

export class AuthService {
  private constructor(
    private readonly users: UserRepository, private readonly tokens: TokenService,
    private readonly dummyHash: string,
  ) {}
  static async create(users: UserRepository, tokens: TokenService) {
    return new AuthService(users, tokens, await hashPassword(randomBytes(32).toString('hex')));
  }
  async register(input: Credentials): Promise<PublicUser> {
    return this.users.create(input.email, await hashPassword(input.password), 'customer');
  }
  async login(input: Credentials) {
    const user = await this.users.findByEmail(input.email);
    // Unknown emails still pay the password verification cost.
    const matches = await argon2.verify(user?.passwordHash ?? this.dummyHash, input.password);
    if (!user || !matches) throw new AuthError(401, 'Invalid credentials');
    return { accessToken: await this.tokens.sign(user), tokenType: 'Bearer', expiresIn: this.tokens.ttlSeconds };
  }
  async currentUser(authorization: string | undefined): Promise<PublicUser> {
    const identity = await this.tokens.verify(authorization);
    const user = await this.users.findById(identity.id);
    if (!user) throw new AuthError(401, 'Unauthorized');
    return user;
  }
}
