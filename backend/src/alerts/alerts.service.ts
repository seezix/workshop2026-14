import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lte, ne, SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/access.js';
import { ApiError } from '../common/api-error.js';
import { DB, type Database } from '../db/database.module.js';
import { Alert, alerts, devices } from '../db/schema.js';
import { RealtimeService } from '../realtime/realtime.service.js';

export type AlertSource = Alert['source'];
export type Severity = Alert['severity'];

// Types autorisés par source (GUIDELINES §6.2).
export const ALERT_TYPES: Record<AlertSource, readonly string[]> = {
  esp: [
    'MOTION_DETECTED',
    'IR_DETECTED',
    'GAS_RISE',
    'SENSOR_FAILURE',
    'TAMPER',
  ],
  vision: [
    'PERSON_DETECTED',
    'PERSON_UNKNOWN',
    'PERSON_RETURNING',
    'PERSON_DENIED',
  ],
  ml: ['ANOMALY_DETECTED'],
  system: ['DEVICE_OFFLINE', 'INTRUSION_CONFIRMED'],
};

/**
 * Détections de présence : ignorées quand le boîtier est désarmé (la trace
 * reste dans device_events). Gaz, sabotage, pannes et anomalies passent
 * toujours.
 */
const PRESENCE_TYPES = new Set([
  'MOTION_DETECTED',
  'IR_DETECTED',
  'PERSON_DETECTED',
  'PERSON_UNKNOWN',
  'PERSON_RETURNING',
  'PERSON_DENIED',
  'INTRUSION_CONFIRMED',
]);

export const DEDUP_WINDOW_MS = 10_000;

export interface NewAlert {
  device_id: string;
  source: AlertSource;
  type: string;
  severity: Severity;
  occurred_at?: Date;
  message?: string;
  details?: Record<string, unknown>;
}

export type AlertListener = (
  alert: Alert,
  outcome: 'created' | 'deduplicated',
  occurredAt: Date,
) => void | Promise<void>;

export type IngestResult =
  | { outcome: 'created'; alert: Alert }
  | { outcome: 'deduplicated'; alert: Alert }
  | { outcome: 'suppressed'; reason: 'device_disarmed' };

export function toAlertDto(a: Alert) {
  return {
    id: a.id,
    device_id: a.deviceId,
    source: a.source,
    type: a.type,
    severity: a.severity,
    status: a.status,
    message: a.message,
    details: a.details,
    occurrences: a.occurrences,
    first_seen_at: a.firstSeenAt,
    last_seen_at: a.lastSeenAt,
    acknowledged_by: a.acknowledgedBy,
    acknowledged_at: a.acknowledgedAt,
    resolved_at: a.resolvedAt,
  };
}

/** Point d'entrée unique des alertes (HTTP et interne). */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger('Alerts');
  private readonly listeners: AlertListener[] = [];

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
  ) {}

  /** Appelé pour chaque alerte créée ou dédoublonnée : règles du backend. */
  onAlert(listener: AlertListener) {
    this.listeners.push(listener);
  }

  async ingest(input: NewAlert): Promise<IngestResult> {
    const occurredAt = input.occurred_at ?? new Date();

    const result = await this.db.transaction(async (tx) => {
      // Verrou sur le boîtier : sérialise la déduplication par boîtier.
      const [device] = await tx
        .select({ armed: devices.armed })
        .from(devices)
        .where(eq(devices.id, input.device_id))
        .for('update');
      if (!device) throw ApiError.notFound('Boîtier');

      if (!device.armed && PRESENCE_TYPES.has(input.type)) {
        return { outcome: 'suppressed', reason: 'device_disarmed' } as const;
      }

      const since = new Date(occurredAt.getTime() - DEDUP_WINDOW_MS);
      const [existing] = await tx
        .select()
        .from(alerts)
        .where(
          and(
            eq(alerts.deviceId, input.device_id),
            eq(alerts.source, input.source),
            eq(alerts.type, input.type),
            ne(alerts.status, 'resolved'),
            gte(alerts.lastSeenAt, since),
          ),
        )
        .orderBy(desc(alerts.lastSeenAt))
        .limit(1);

      if (existing) {
        const [updated] = await tx
          .update(alerts)
          .set({
            occurrences: existing.occurrences + 1,
            lastSeenAt:
              occurredAt > existing.lastSeenAt
                ? occurredAt
                : existing.lastSeenAt,
            severity: maxSeverity(existing.severity, input.severity),
          })
          .where(eq(alerts.id, existing.id))
          .returning();
        return { outcome: 'deduplicated', alert: updated } as const;
      }

      const [created] = await tx
        .insert(alerts)
        .values({
          deviceId: input.device_id,
          source: input.source,
          type: input.type,
          severity: input.severity,
          status: 'open',
          message: input.message?.slice(0, 140) ?? null,
          details: input.details ?? {},
          occurrences: 1,
          firstSeenAt: occurredAt,
          lastSeenAt: occurredAt,
        })
        .returning();
      return { outcome: 'created', alert: created } as const;
    });

    if (result.outcome === 'suppressed') return result;

    this.realtime.emit(
      result.outcome === 'created' ? 'alert.created' : 'alert.updated',
      toAlertDto(result.alert),
    );
    for (const listener of this.listeners) {
      Promise.resolve(listener(result.alert, result.outcome, occurredAt)).catch(
        (err: Error) =>
          this.logger.error(
            `Règle sur alerte ${result.alert.type} : ${err.message}`,
          ),
      );
    }
    return result;
  }

  list(filters: {
    status?: string;
    device_id?: string;
    source?: string;
    severity?: string;
    limit: number;
  }) {
    const where: SQL[] = [];
    if (filters.status)
      where.push(eq(alerts.status, filters.status as Alert['status']));
    if (filters.device_id) where.push(eq(alerts.deviceId, filters.device_id));
    if (filters.source)
      where.push(eq(alerts.source, filters.source as AlertSource));
    if (filters.severity)
      where.push(eq(alerts.severity, filters.severity as Severity));
    return this.db
      .select()
      .from(alerts)
      .where(and(...where))
      .orderBy(desc(alerts.lastSeenAt))
      .limit(filters.limit);
  }

  async updateStatus(
    id: string,
    status: 'acknowledged' | 'resolved',
    principal: Principal,
    ip?: string,
  ) {
    const [current] = await this.db
      .select()
      .from(alerts)
      .where(eq(alerts.id, id))
      .limit(1);
    if (!current) throw ApiError.notFound('Alerte');

    const now = new Date();
    const userId = principal.kind === 'user' ? principal.id : null;
    const [updated] = await this.db
      .update(alerts)
      .set(
        status === 'acknowledged'
          ? { status, acknowledgedBy: userId, acknowledgedAt: now }
          : {
              status,
              resolvedAt: now,
              // Résoudre une alerte non acquittée vaut acquittement.
              ...(current.acknowledgedAt
                ? {}
                : { acknowledgedBy: userId, acknowledgedAt: now }),
            },
      )
      .where(eq(alerts.id, id))
      .returning();

    await this.audit.log({
      action: `alert.${status}`,
      principal,
      ip,
      details: {
        alert_id: id,
        type: current.type,
        device_id: current.deviceId,
        previous_status: current.status,
      },
    });
    this.realtime.emit('alert.updated', toAlertDto(updated));
    return updated;
  }

  /** Une alerte de ces types était-elle active à ±windowMs de cet instant ? */
  async activeNear(
    deviceId: string,
    source: AlertSource,
    types: string[],
    at: Date,
    windowMs: number,
  ) {
    const [row] = await this.db
      .select({ id: alerts.id })
      .from(alerts)
      .where(
        and(
          eq(alerts.deviceId, deviceId),
          eq(alerts.source, source),
          inArray(alerts.type, types),
          gte(alerts.lastSeenAt, new Date(at.getTime() - windowMs)),
          lte(alerts.firstSeenAt, new Date(at.getTime() + windowMs)),
        ),
      )
      .limit(1);
    return row !== undefined;
  }
}

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };
function maxSeverity(a: Severity, b: Severity): Severity {
  return RANK[a] >= RANK[b] ? a : b;
}
