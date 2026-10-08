import { Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { isIP } from 'node:net';
import { actorName, type Principal } from '../auth/access.js';
import { DB, type Database } from '../db/database.module.js';
import { auditLog } from '../db/schema.js';

export interface AuditEntry {
  action: string;
  principal?: Principal;
  /** Remplace l'acteur calculé (ex. "system", ou le login tenté). */
  actor?: string;
  userId?: string | null;
  ip?: string | null;
  details?: Record<string, unknown>;
}

/** Connexions, échecs et actions sensibles (GUIDELINES §9). */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(@Inject(DB) private readonly db: Database) {}

  async log(entry: AuditEntry): Promise<void> {
    const ip = entry.ip ? entry.ip.replace(/^::ffff:/, '') : null;
    try {
      await this.db.insert(auditLog).values({
        actor: entry.actor ?? actorName(entry.principal),
        action: entry.action,
        userId:
          entry.userId ??
          (entry.principal?.kind === 'user' ? entry.principal.id : null),
        ip: ip && isIP(ip) ? ip : null,
        details: entry.details ?? {},
      });
    } catch (err) {
      // L'audit ne doit jamais faire échouer l'action elle-même.
      this.logger.error(
        `Écriture audit impossible (${entry.action}) : ${(err as Error).message}`,
      );
    }
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
