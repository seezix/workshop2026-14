import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, gte, lte } from 'drizzle-orm';
import { AlertsService } from '../alerts/alerts.service.js';
import { ApiError } from '../common/api-error.js';
import { DB, type Database } from '../db/database.module.js';
import { Alert, deviceEvents } from '../db/schema.js';
import { CommandsService } from '../commands/commands.service.js';

export const INTRUSION_WINDOW_MS = 5_000;
const PERSON_TYPES = [
  'PERSON_DETECTED',
  'PERSON_UNKNOWN',
  'PERSON_RETURNING',
  'PERSON_DENIED',
];

/**
 * « L'IA détecte, le backend décide » (GUIDELINES §6.3) : toutes les actions
 * automatiques sur le boîtier partent d'ici.
 *
 * Règle intrusion : PIR (MOTION_DETECTED) et vision (PERSON_*) d'accord dans
 * les 5 s → alerte système INTRUSION_CONFIRMED, puis, si le boîtier est armé,
 * buzzer + LED rouge (issuer rule:intrusion).
 */
@Injectable()
export class RulesService implements OnModuleInit {
  private readonly logger = new Logger('Rules');

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly alerts: AlertsService,
    private readonly commands: CommandsService,
  ) {}

  onModuleInit() {
    this.alerts.onAlert((alert, _outcome, occurredAt) =>
      this.onAlert(alert, occurredAt),
    );
  }

  /** Appelé par l'ingestion MQTT pour chaque MOTION_DETECTED enregistré. */
  async onMotion(deviceId: string, at: Date) {
    const visionAgrees = await this.alerts.activeNear(
      deviceId,
      'vision',
      PERSON_TYPES,
      at,
      INTRUSION_WINDOW_MS,
    );
    if (visionAgrees)
      await this.confirmIntrusion(deviceId, at, 'pir_then_vision');
  }

  private async onAlert(alert: Alert, at: Date) {
    if (alert.source !== 'vision' || !PERSON_TYPES.includes(alert.type)) return;
    const [motion] = await this.db
      .select({ id: deviceEvents.id })
      .from(deviceEvents)
      .where(
        and(
          eq(deviceEvents.deviceId, alert.deviceId),
          eq(deviceEvents.type, 'MOTION_DETECTED'),
          gte(deviceEvents.time, new Date(at.getTime() - INTRUSION_WINDOW_MS)),
          lte(deviceEvents.time, new Date(at.getTime() + INTRUSION_WINDOW_MS)),
        ),
      )
      .limit(1);
    if (motion)
      await this.confirmIntrusion(alert.deviceId, at, 'vision_then_pir', alert);
  }

  private async confirmIntrusion(
    deviceId: string,
    at: Date,
    trigger: string,
    visionAlert?: Alert,
  ) {
    const result = await this.alerts.ingest({
      device_id: deviceId,
      source: 'system',
      type: 'INTRUSION_CONFIRMED',
      severity: 'critical',
      occurred_at: at,
      message: 'Intrusion confirmée : mouvement et personne détectés',
      details: {
        trigger,
        ...(visionAlert ? { vision_alert_id: visionAlert.id } : {}),
      },
    });
    // Désarmé : alerte supprimée, aucune action. Doublon : l'alarme sonne déjà.
    if (result.outcome !== 'created') return;

    this.logger.warn(
      `Intrusion confirmée sur ${deviceId}, déclenchement de l'alarme`,
    );
    try {
      await this.commands.issue(
        deviceId,
        { action: 'BUZZER', params: { mode: 'beep', duration_ms: 10_000 } },
        'rule:intrusion',
      );
      await this.commands.issue(
        deviceId,
        { action: 'LED', params: { color: 'red', blink: true } },
        'rule:intrusion',
      );
    } catch (err) {
      const reason =
        err instanceof ApiError ? err.code : (err as Error).message;
      this.logger.warn(`Alarme non déclenchée sur ${deviceId} : ${reason}`);
    }
  }
}
