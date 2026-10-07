import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { actorName, AuthedRequest } from '../auth/access.js';
import { ApiError } from './api-error.js';

export interface RateLimitRule {
  limit: number;
  windowMs: number;
  /** Clé de comptage : adresse IP ou appelant authentifié. */
  by: 'ip' | 'principal';
}

const RATE_LIMIT_KEY = 'sx:rate-limit';
export const RateLimit = (rule: RateLimitRule) =>
  SetMetadata(RATE_LIMIT_KEY, rule);

/**
 * Limite de débit en mémoire, fenêtre fixe (GUIDELINES §9 : 5 logins/min/IP,
 * 10 alertes/s/service). Suffisant pour une seule instance du backend.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly windows = new Map<
    string,
    { start: number; count: number }
  >();
  private lastSweep = Date.now();

  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const rule = this.reflector.get<RateLimitRule | undefined>(
      RATE_LIMIT_KEY,
      ctx.getHandler(),
    );
    if (!rule) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const who =
      rule.by === 'ip' ? (req.ip ?? 'unknown') : actorName(req.principal);
    const key = `${ctx.getClass().name}.${ctx.getHandler().name}:${who}`;
    const now = Date.now();
    this.sweep(now);

    const win = this.windows.get(key);
    if (!win || now - win.start >= rule.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    win.count += 1;
    if (win.count > rule.limit) {
      const retryS = Math.ceil((win.start + rule.windowMs - now) / 1000);
      ctx
        .switchToHttp()
        .getResponse()
        .setHeader('Retry-After', String(Math.max(retryS, 1)));
      throw new ApiError(
        'RATE_LIMITED',
        'Trop de requêtes, réessayez plus tard',
      );
    }
    return true;
  }

  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, win] of this.windows) {
      if (now - win.start > 10 * 60_000) this.windows.delete(key);
    }
  }
}
