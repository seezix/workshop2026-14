import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from '../common/api-error.js';
import { ENV, type Env, parseServiceKeys } from '../config/env.js';
import type { Role } from '../db/schema.js';
import {
  ACCESS_KEY,
  AccessRule,
  AuthedRequest,
  hasRole,
  Principal,
} from './access.js';

export const AUTH_COOKIE = 'sx_token';

export interface JwtPayload {
  sub: string;
  username: string;
  role: Role;
}

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly serviceKeys: Map<string, string>;

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @Inject(ENV) env: Env,
  ) {
    this.serviceKeys = parseServiceKeys(env.SERVICE_API_KEYS);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.getAllAndOverride<AccessRule | undefined>(
      ACCESS_KEY,
      [ctx.getHandler(), ctx.getClass()],
    ) ?? { role: 'viewer' };
    if (rule.public) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const principal = (await this.fromJwt(req)) ?? this.fromApiKey(req);
    if (!principal)
      throw new ApiError('UNAUTHORIZED', 'Authentification requise');

    const allowed =
      principal.kind === 'user'
        ? rule.role !== undefined && hasRole(principal.role, rule.role)
        : rule.services === true;
    if (!allowed) throw new ApiError('FORBIDDEN', 'Droits insuffisants');

    req.principal = principal;
    return true;
  }

  private async fromJwt(req: AuthedRequest): Promise<Principal | null> {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ')
      ? header.slice(7)
      : (req.cookies as Record<string, string> | undefined)?.[AUTH_COOKIE];
    if (!token) return null;
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        algorithms: ['HS256'],
      });
      return {
        kind: 'user',
        id: payload.sub,
        username: payload.username,
        role: payload.role,
      };
    } catch {
      throw new ApiError('UNAUTHORIZED', 'Jeton invalide ou expiré');
    }
  }

  private fromApiKey(req: AuthedRequest): Principal | null {
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || key.length === 0) return null;
    const given = Buffer.from(key);
    for (const [candidate, name] of this.serviceKeys) {
      const expected = Buffer.from(candidate);
      if (
        expected.length === given.length &&
        timingSafeEqual(expected, given)
      ) {
        return { kind: 'service', name };
      }
    }
    throw new ApiError('UNAUTHORIZED', 'Clé de service invalide');
  }
}
