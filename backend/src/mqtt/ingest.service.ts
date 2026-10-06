import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { AlertsService, Severity } from '../alerts/alerts.service.js';
import { CommandsService } from '../commands/commands.service.js';
import { DB, type Database } from '../db/database.module.js';
import { deviceEvents, telemetry } from '../db/schema.js';
import { DevicesService } from '../devices/devices.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { RulesService } from '../rules/rules.service.js';
import { toTelemetryDto } from '../telemetry/telemetry.dto.js';
import { DeviceClock } from './device-clock.js';
import {
  AckMessage,
  EventMessage,
  StatusMessage,
  TelemetryMessage,
} from './messages.js';
import { MqttService } from './mqtt.service.js';

// Événements ESP qui deviennent des alertes (GUIDELINES §6.2).
const EVENT_ALERTS: Record<string, { severity: Severity; message: string }> = {
  MOTION_DETECTED: { severity: 'warning', message: 'Mouvement détecté' },
  IR_DETECTED: {
    severity: 'warning',
    message: 'Présence détectée par le capteur IR',
  },
  GAS_RISE: { severity: 'critical', message: 'Montée rapide du taux de gaz' },
  TAMPER: { severity: 'critical', message: 'Tentative de sabotage du boîtier' },
  SENSOR_FAILURE: { severity: 'warning', message: 'Capteur en panne' },
};

/** Messages ESP → backend : telemetry, events, status, cmd/ack. */
@Injectable()
export class IngestService implements OnModuleInit {
  private readonly logger = new Logger('Ingest');
  private readonly clock = new DeviceClock();
  private readonly unknownDevices = new Set<string>();
  // File par boîtier : les messages d'un même ESP sont traités dans l'ordre d'arrivée.
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly mqtt: MqttService,
    private readonly devices: DevicesService,
    private readonly alerts: AlertsService,
    private readonly commands: CommandsService,
    private readonly rules: RulesService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit() {
    this.mqtt.onMessage((deviceId, channel, payload) =>
      this.enqueue(deviceId, channel, payload),
    );
  }

  private enqueue(deviceId: string, channel: string, payload: Buffer) {
    const receivedAt = Date.now();
    const previous = this.queues.get(deviceId) ?? Promise.resolve();
    const next = previous
      .then(() => this.handle(deviceId, channel, payload, receivedAt))
      .catch((err: Error) =>
        this.logger.error(`${deviceId}/${channel} : ${err.message}`),
      );
    this.queues.set(deviceId, next);
    void next.finally(() => {
      if (this.queues.get(deviceId) === next) this.queues.delete(deviceId);
    });
    return next;
  }

  async handle(
    deviceId: string,
    channel: string,
    payload: Buffer,
    receivedAt = Date.now(),
  ) {
    // Seuls les boîtiers déclarés dans `devices` sont acceptés.
    const device = await this.devices.find(deviceId);
    if (!device) {
      if (
        !this.unknownDevices.has(deviceId) &&
        this.unknownDevices.size < 100
      ) {
        this.unknownDevices.add(deviceId);
        this.logger.warn(
          `Boîtier inconnu ${deviceId.slice(0, 32)} ignoré (ajouter une ligne dans devices)`,
        );
      }
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(payload.toString('utf8'));
    } catch {
      this.logger.warn(`${deviceId}/${channel} : JSON invalide`);
      return;
    }

    switch (channel) {
      case 'telemetry':
        return this.onTelemetry(deviceId, json, receivedAt);
      case 'events':
        return this.onEvent(deviceId, json, receivedAt);
      case 'status':
        return this.onStatus(deviceId, json);
      case 'cmd/ack':
        return this.onAck(deviceId, json);
    }
  }

  private parse<T extends z.ZodType>(
    schema: T,
    json: unknown,
    where: string,
  ): z.infer<T> | undefined {
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      this.logger.warn(
        `${where} rejeté : ${issue.path.join('.')} ${issue.message}`,
      );
      return undefined;
    }
    return parsed.data;
  }

  private async onTelemetry(
    deviceId: string,
    json: unknown,
    receivedAt: number,
  ) {
    const msg = this.parse(TelemetryMessage, json, `${deviceId}/telemetry`);
    if (!msg) return;
    const time = new Date(
      this.clock.resolve(deviceId, msg.uptime_ms, receivedAt),
    );
    const round = (v: number | null | undefined) =>
      v === null || v === undefined ? null : Math.round(v);

    const [row] = await this.db
      .insert(telemetry)
      .values({
        time,
        deviceId,
        seq: msg.seq ?? null,
        uptimeMs: msg.uptime_ms ?? null,
        intervalS: msg.interval_s,
        samples: msg.samples,
        tempAvg: msg.temperature_c?.avg ?? null,
        tempMin: msg.temperature_c?.min ?? null,
        tempMax: msg.temperature_c?.max ?? null,
        tempLast: msg.temperature_c?.last ?? null,
        humAvg: msg.humidity_pct?.avg ?? null,
        humMin: msg.humidity_pct?.min ?? null,
        humMax: msg.humidity_pct?.max ?? null,
        humLast: msg.humidity_pct?.last ?? null,
        gasAvg: round(msg.gas_raw?.avg),
        gasMin: round(msg.gas_raw?.min),
        gasMax: round(msg.gas_raw?.max),
        gasLast: round(msg.gas_raw?.last),
        motionCount: msg.motion_count,
        irCount: msg.ir_count,
        rssiDbm: msg.rssi_dbm ?? null,
      })
      .returning();
    await this.devices.touch(deviceId);
    this.realtime.emit('telemetry.new', toTelemetryDto(row));
  }

  private async onEvent(deviceId: string, json: unknown, receivedAt: number) {
    const msg = this.parse(EventMessage, json, `${deviceId}/events`);
    if (!msg) return;
    if (msg.type === 'BOOT') this.clock.reset(deviceId);
    const time = new Date(
      this.clock.resolve(deviceId, msg.uptime_ms, receivedAt),
    );

    const { seq, uptime_ms, type, duration_ms, ...extra } = msg;
    const [event] = await this.db
      .insert(deviceEvents)
      .values({
        time,
        deviceId,
        seq: seq ?? null,
        uptimeMs: uptime_ms ?? null,
        type,
        durationMs: duration_ms ?? null,
        payload: extra,
      })
      .returning();
    await this.devices.touch(deviceId);
    this.realtime.emit('device_event.new', {
      id: event.id,
      time: event.time,
      device_id: deviceId,
      seq: event.seq,
      type: event.type,
      duration_ms: event.durationMs,
      payload: event.payload,
    });

    const alert = EVENT_ALERTS[type];
    if (alert) {
      // Désarmé : la détection reste dans device_events, ingest() ne crée pas d'alerte.
      await this.alerts.ingest({
        device_id: deviceId,
        source: 'esp',
        type,
        severity: alert.severity,
        occurred_at: time,
        message:
          type === 'SENSOR_FAILURE' && typeof extra.sensor === 'string'
            ? `Capteur en panne : ${extra.sensor.slice(0, 32)}`
            : alert.message,
        details: { event_id: event.id, ...extra },
      });
    }
    if (type === 'MOTION_DETECTED') await this.rules.onMotion(deviceId, time);
  }

  private async onStatus(deviceId: string, json: unknown) {
    const msg = this.parse(StatusMessage, json, `${deviceId}/status`);
    if (!msg) return;
    const res = await this.devices.applyStatus(
      deviceId,
      msg.state,
      msg.fw,
      msg.ip,
    );
    if (!res) return;
    this.logger.log(
      `${deviceId} ${msg.state}${msg.fw ? ` (fw ${msg.fw})` : ''}`,
    );
    if (msg.state === 'offline' && res.previous.status === 'online') {
      await this.alerts.ingest({
        device_id: deviceId,
        source: 'system',
        type: 'DEVICE_OFFLINE',
        severity: 'warning',
        message: 'Boîtier hors ligne',
        details: { last_seen_at: res.previous.lastSeenAt },
      });
    }
  }

  private async onAck(deviceId: string, json: unknown) {
    const msg = this.parse(AckMessage, json, `${deviceId}/cmd/ack`);
    if (!msg) return;
    await this.commands.handleAck(deviceId, msg.cmd_id, msg.status, msg.reason);
  }
}
