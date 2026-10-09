import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, gte, lte } from 'drizzle-orm';
import { AlertsService } from '../alerts/alerts.service.js';
import { ApiError } from '../common/api-error.js';
import { DB, type Database } from '../db/database.module.js';
import { Alert, deviceEvents } from '../db/schema.js';
import {
  CommandsService,
  type CommandInput,
} from '../commands/commands.service.js';

export const INTRUSION_WINDOW_MS = 5_000;
/** Au-delà, l'alerte est rejouée (tampon hors ligne de l'ESP) : aucun signal. */
export const SIGNAL_MAX_AGE_MS = 30_000;

// Signal du boîtier pour chaque nouvelle alerte, selon sa gravité.
export const ALERT_SIGNALS: Record<Alert['severity'], CommandInput[]> = {
  // Alarme : bips 10 s et LED rouge, jusqu'à ce qu'un opérateur l'éteigne.
  critical: [
    { action: 'BUZZER', params: { mode: 'beep', duration_ms: 10_000 } },
    { action: 'LED', params: { color: 'red', blink: true } },
  ],
  warning: [{ action: 'LED', params: { color: 'red', duration_ms: 2_000 } }],
  info: [{ action: 'LED', params: { color: 'green', duration_ms: 2_000 } }],
};
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
 * les 5 s → alerte système INTRUSION_CONFIRMED (ignorée si le boîtier est
 * désarmé).
 *
 * Règle signal : toute nouvelle alerte se voit sur le boîtier (ALERT_SIGNALS,
 * issuer rule:alert-<gravité>) : alarme et LED rouge pour critical, flash rouge
 * pour warning, flash vert pour info.
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
    this.alerts.onAlert(async (alert, outcome, occurredAt) => {
      // Doublon : le boîtier a déjà signalé cette alerte.
      if (outcome === 'created') await this.signal(alert, occurredAt);
      await this.onAlert(alert, occurredAt);
    });
  }

  private async signal(alert: Alert, at: Date) {
    if (Date.now() - at.getTime() > SIGNAL_MAX_AGE_MS) return;
    try {
      for (const command of ALERT_SIGNALS[alert.severity]) {
        await this.commands.issue(
          alert.deviceId,
          command,
          `rule:alert-${alert.severity}`,
        );
      }
    } catch (err) {
      // Boîtier simulé ou hors ligne (dont sa propre alerte DEVICE_OFFLINE) : rien à signaler.
      if (err instanceof ApiError && err.code === 'DEVICE_OFFLINE') return;
      const reason =
        err instanceof ApiError ? err.code : (err as Error).message;
      this.logger.warn(
        `Alerte ${alert.type} non signalée sur ${alert.deviceId} : ${reason}`,
      );
    }
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
    // Alerte critical : c'est la règle signal qui déclenche l'alarme du boîtier.
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
    // Désarmé : alerte supprimée. Doublon : déjà signalée.
    if (result.outcome === 'created')
      this.logger.warn(`Intrusion confirmée sur ${deviceId}`);
  }
}
