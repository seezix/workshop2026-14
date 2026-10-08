import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Role } from '../db/schema.js';

export type Principal =
  | { kind: 'user'; id: string; username: string; role: Role }
  | { kind: 'service'; name: string };

export interface AccessRule {
  /** Pas d'authentification (login, health). */
  public?: boolean;
  /** Rôle minimal pour un utilisateur ; absent = utilisateurs refusés. */
  role?: Role;
  /** Services internes authentifiés par X-Api-Key. */
  services?: boolean;
}

export const ACCESS_KEY = 'sx:access';

/** Par défaut (sans décorateur) : rôle viewer, services refusés. */
export const Access = (rule: AccessRule) => SetMetadata(ACCESS_KEY, rule);
export const Public = () => Access({ public: true });

const RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };
export const hasRole = (actual: Role, required: Role) =>
  RANK[actual] >= RANK[required];

export type AuthedRequest = Request & { principal?: Principal };

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Principal | undefined =>
    ctx.switchToHttp().getRequest<AuthedRequest>().principal,
);

/** Nom lisible pour audit_log.actor et commands.issuer. */
export function actorName(p: Principal | undefined): string {
  if (!p) return 'anonymous';
  return p.kind === 'user' ? `user:${p.username}` : `service:${p.name}`;
}
