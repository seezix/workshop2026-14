import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ApiError } from '../common/api-error.js';
import { RateLimitGuard } from '../common/rate-limit.js';
import type { Env } from '../config/env.js';
import type { AccessRule } from './access.js';
import { AuthGuard } from './auth.guard.js';

const SECRET = 'x'.repeat(32);
const SERVICE_KEY = 'k'.repeat(24);

const handler = () => undefined;
class TestController {}

function context(req: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => TestController,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ setHeader: () => undefined }),
    }),
  } as unknown as ExecutionContext;
}

function guardFor(rule?: AccessRule) {
  const jwt = new JwtService({
    secret: SECRET,
    signOptions: { algorithm: 'HS256', expiresIn: 60 },
  });
  const reflector = { getAllAndOverride: () => rule } as unknown as Reflector;
  const env = { SERVICE_API_KEYS: `vision=${SERVICE_KEY}` } as Env;
  return { guard: new AuthGuard(reflector, jwt, env), jwt };
}

async function code(p: Promise<unknown>) {
  try {
    await p;
    return 'OK';
  } catch (err) {
    return err instanceof ApiError ? err.code : 'OTHER';
  }
}

describe('AuthGuard', () => {
  const tokenFor = (jwt: JwtService, role: string) =>
    jwt.sign({ sub: 'u1', username: 'alice', role });

  it('refuse sans authentification', async () => {
    const { guard } = guardFor();
    expect(await code(guard.canActivate(context({ headers: {} })))).toBe(
      'UNAUTHORIZED',
    );
  });

  it('laisse passer une route publique', async () => {
    const { guard } = guardFor({ public: true });
    expect(await code(guard.canActivate(context({ headers: {} })))).toBe('OK');
  });

  it('applique la hiérarchie viewer < operator < admin', async () => {
    const { guard, jwt } = guardFor({ role: 'operator' });
    const req = (role: string) => ({
      headers: { authorization: `Bearer ${tokenFor(jwt, role)}` },
    });
    expect(await code(guard.canActivate(context(req('viewer'))))).toBe(
      'FORBIDDEN',
    );
    expect(await code(guard.canActivate(context(req('operator'))))).toBe('OK');
    expect(await code(guard.canActivate(context(req('admin'))))).toBe('OK');
  });

  it('lit le jeton dans le cookie httpOnly (SSE)', async () => {
    const { guard, jwt } = guardFor();
    const req = {
      headers: {},
      cookies: { sx_token: tokenFor(jwt, 'viewer') },
    } as Record<string, unknown>;
    expect(await code(guard.canActivate(context(req)))).toBe('OK');
    expect(req.principal).toMatchObject({
      kind: 'user',
      username: 'alice',
      role: 'viewer',
    });
  });

  it('refuse un jeton signé avec un autre secret', async () => {
    const { guard } = guardFor();
    const forged = new JwtService({ secret: 'y'.repeat(32) }).sign({
      sub: 'u1',
      username: 'eve',
      role: 'admin',
    });
    expect(
      await code(
        guard.canActivate(
          context({ headers: { authorization: `Bearer ${forged}` } }),
        ),
      ),
    ).toBe('UNAUTHORIZED');
  });

  it("n'accepte les services que sur les routes qui l'autorisent", async () => {
    const req = () => ({ headers: { 'x-api-key': SERVICE_KEY } });
    expect(
      await code(
        guardFor({ services: true }).guard.canActivate(context(req())),
      ),
    ).toBe('OK');
    expect(
      await code(
        guardFor({ role: 'viewer' }).guard.canActivate(context(req())),
      ),
    ).toBe('FORBIDDEN');
    expect(
      await code(
        guardFor({ services: true }).guard.canActivate(
          context({ headers: { 'x-api-key': 'bad' } }),
        ),
      ),
    ).toBe('UNAUTHORIZED');
  });

  it('refuse un utilisateur sur une route réservée aux services', async () => {
    const { guard, jwt } = guardFor({ services: true });
    const req = {
      headers: { authorization: `Bearer ${tokenFor(jwt, 'admin')}` },
    };
    expect(await code(guard.canActivate(context(req)))).toBe('FORBIDDEN');
  });
});

describe('RateLimitGuard', () => {
  it('bloque au-delà de la limite puis repart avec une nouvelle fenêtre', () => {
    vi.useFakeTimers();
    const rule = { limit: 5, windowMs: 60_000, by: 'ip' };
    const reflector = { get: () => rule } as unknown as Reflector;
    const guard = new RateLimitGuard(reflector);
    const ctx = context({ ip: '10.0.0.1', headers: {} });
    for (let i = 0; i < 5; i++) expect(guard.canActivate(ctx)).toBe(true);
    expect(() => guard.canActivate(ctx)).toThrow(ApiError);
    // Une autre IP n'est pas concernée.
    expect(guard.canActivate(context({ ip: '10.0.0.2', headers: {} }))).toBe(
      true,
    );
    vi.advanceTimersByTime(60_000);
    expect(guard.canActivate(ctx)).toBe(true);
    vi.useRealTimers();
  });
});
