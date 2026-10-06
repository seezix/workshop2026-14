import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/api-error.js';
import { RateLimit } from '../common/rate-limit.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { ENV, type Env } from '../config/env.js';
import { DB, type Database } from '../db/database.module.js';
import { users } from '../db/schema.js';
import { Public } from './access.js';
import { AUTH_COOKIE, JwtPayload } from './auth.guard.js';

const LoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

// Hash factice pour que la durée de réponse ne trahisse pas l'existence du compte.
const DUMMY_HASH = bcrypt.hashSync('sentinel-x-dummy-password', 12);

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async login(username: string, password: string, ip: string | undefined) {
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      await this.audit.log({
        action: 'auth.login_failed',
        actor: `login:${username.slice(0, 64)}`,
        ip,
      });
      throw new ApiError('UNAUTHORIZED', 'Identifiants invalides');
    }

    await this.db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, user.id));
    await this.audit.log({
      action: 'auth.login',
      actor: `user:${user.username}`,
      userId: user.id,
      ip,
    });

    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
    };
    const token = await this.jwt.signAsync(payload);
    return {
      token,
      expiresIn: this.env.JWT_TTL_S,
      user: { id: user.id, username: user.username, role: user.role },
    };
  }
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  @RateLimit({ limit: 5, windowMs: 60_000, by: 'ip' })
  async login(
    @Body(new ZodPipe(LoginSchema)) body: z.infer<typeof LoginSchema>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(body.username, body.password, req.ip);
    // Cookie httpOnly : utilisé par EventSource pour le flux SSE.
    res.cookie(AUTH_COOKIE, result.token, {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: 'strict',
      path: '/api/',
      maxAge: result.expiresIn * 1000,
    });
    return {
      access_token: result.token,
      token_type: 'Bearer',
      expires_in: result.expiresIn,
      user: result.user,
    };
  }

  @Post('logout')
  @Public()
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(AUTH_COOKIE, { path: '/api/' });
  }
}

@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      inject: [ENV],
      useFactory: (env: Env) => ({
        secret: env.JWT_SECRET,
        signOptions: { algorithm: 'HS256', expiresIn: env.JWT_TTL_S },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
