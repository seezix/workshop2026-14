import { Inject, Injectable, Logger } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { isIP } from 'node:net';
import { AuditService } from '../audit/audit.service.js';
import type { Principal } from '../auth/access.js';
import { ApiError } from '../common/api-error.js';
import { DB, type Database } from '../db/database.module.js';
import { Device, devices } from '../db/schema.js';
import { MqttService } from '../mqtt/mqtt.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';

export function toDeviceDto(d: Device) {
  return {
    id: d.id,
    name: d.name,
    location: d.location,
    is_simulated: d.isSimulated,
    status: d.status,
    fw_version: d.fwVersion,
    ip: d.ip,
    last_seen_at: d.lastSeenAt,
    config: { interval_s: d.intervalS, armed: d.armed },
    created_at: d.createdAt,
  };
}

@Injectable()
export class DevicesService {
  private readonly logger = new Logger('Devices');

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly mqtt: MqttService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
  ) {
    // Le broker peut avoir perdu ses messages retenus (redémarrage, reconstruction
    // après le pentest) : on republie la config voulue à chaque connexion.
    this.mqtt.onConnect(() => void this.republishConfigs());
  }

  list() {
    return this.db.select().from(devices).orderBy(asc(devices.id));
  }

  async find(id: string): Promise<Device | undefined> {
    const [device] = await this.db
      .select()
      .from(devices)
      .where(eq(devices.id, id))
      .limit(1);
    return device;
  }

  async get(id: string): Promise<Device> {
    const device = await this.find(id);
    if (!device) throw ApiError.notFound('Boîtier');
    return device;
  }

  async updateConfig(
    id: string,
    patch: { interval_s?: number; armed?: boolean },
    principal: Principal,
    ip?: string,
  ): Promise<Device> {
    const current = await this.get(id);
    const [updated] = await this.db
      .update(devices)
      .set({
        intervalS: patch.interval_s ?? current.intervalS,
        armed: patch.armed ?? current.armed,
      })
      .where(eq(devices.id, id))
      .returning();

    await this.audit.log({
      action: 'device.config',
      principal,
      ip,
      details: {
        device_id: id,
        before: { interval_s: current.intervalS, armed: current.armed },
        after: { interval_s: updated.intervalS, armed: updated.armed },
      },
    });

    if (!updated.isSimulated) {
      try {
        await this.mqtt.publishConfig(id, {
          interval_s: updated.intervalS,
          armed: updated.armed,
        });
      } catch (err) {
        // La config est enregistrée ; elle sera republiée à la reconnexion du broker.
        this.logger.warn(
          `Config ${id} non publiée : ${(err as Error).message}`,
        );
      }
    }
    this.realtime.emit('device.status', toDeviceDto(updated));
    return updated;
  }

  /** Message status (retained + Last Will). Renvoie l'état précédent. */
  async applyStatus(
    id: string,
    state: 'online' | 'offline',
    fw?: string,
    ip?: string,
  ) {
    const current = await this.find(id);
    if (!current) return undefined;
    const [updated] = await this.db
      .update(devices)
      .set({
        status: state,
        lastSeenAt: state === 'online' ? new Date() : current.lastSeenAt,
        ...(fw ? { fwVersion: fw } : {}),
        ...(ip && isIP(ip) ? { ip } : {}),
      })
      .where(eq(devices.id, id))
      .returning();
    if (current.status !== updated.status || state === 'online') {
      this.realtime.emit('device.status', toDeviceDto(updated));
    }
    return { previous: current, updated };
  }

  async touch(id: string) {
    await this.db
      .update(devices)
      .set({ lastSeenAt: new Date() })
      .where(eq(devices.id, id));
  }

  private async republishConfigs() {
    try {
      const all = await this.list();
      for (const d of all.filter((x) => !x.isSimulated)) {
        await this.mqtt.publishConfig(d.id, {
          interval_s: d.intervalS,
          armed: d.armed,
        });
      }
    } catch (err) {
      this.logger.warn(`Republication des configs : ${(err as Error).message}`);
    }
  }
}
