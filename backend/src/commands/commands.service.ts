import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { actorName, type Principal } from '../auth/access.js';
import { ApiError } from '../common/api-error.js';
import { DB, type Database } from '../db/database.module.js';
import { Command, commands } from '../db/schema.js';
import { DevicesService } from '../devices/devices.service.js';
import { MqttService } from '../mqtt/mqtt.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';

export const ACK_TIMEOUT_MS = 5_000;

// Actions et limites (GUIDELINES §5.3). L'ESP applique aussi les siennes.
export const CommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('BUZZER'),
    params: z
      .object({
        mode: z.enum(['on', 'off', 'beep']),
        duration_ms: z.number().int().min(1).max(10_000).optional(),
      })
      .strict(),
  }),
  z.object({
    action: z.literal('LED'),
    params: z
      .object({
        color: z.enum(['red', 'green', 'off']),
        blink: z.boolean().optional(),
      })
      .strict(),
  }),
]);
export type CommandInput = z.infer<typeof CommandSchema>;

/** user, rule:<nom> ou service:<nom> */
export type Issuer = 'user' | `rule:${string}` | `service:${string}`;

export function toCommandDto(c: Command) {
  return {
    cmd_id: c.id,
    device_id: c.deviceId,
    action: c.action,
    params: c.params,
    status: c.status,
    reason: c.reason,
    issuer: c.issuer,
    issued_by: c.issuedBy,
    issued_at: c.issuedAt,
    acked_at: c.ackedAt,
  };
}

/** Parcours d'une commande (GUIDELINES §6.3, docs/sequence-commande.puml). */
@Injectable()
export class CommandsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Commands');
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly devices: DevicesService,
    private readonly mqtt: MqttService,
    private readonly realtime: RealtimeService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit() {
    // Commandes restées pending lors d'un arrêt du backend.
    await this.db
      .update(commands)
      .set({ status: 'timeout' })
      .where(
        and(
          eq(commands.status, 'pending'),
          lt(commands.issuedAt, new Date(Date.now() - ACK_TIMEOUT_MS)),
        ),
      );
  }

  onModuleDestroy() {
    for (const timer of this.timers.values()) clearTimeout(timer);
  }

  async issue(
    deviceId: string,
    input: CommandInput,
    issuer: Issuer,
    principal?: Principal,
    ip?: string,
  ): Promise<Command> {
    const device = await this.devices.get(deviceId);
    if (device.isSimulated || device.status !== 'online') {
      throw new ApiError('DEVICE_OFFLINE', 'Le boîtier est hors ligne');
    }

    const id = `c-${randomBytes(6).toString('hex')}`;
    const [command] = await this.db
      .insert(commands)
      .values({
        id,
        deviceId,
        action: input.action,
        params: input.params,
        status: 'pending',
        issuer,
        issuedBy:
          issuer === 'user' && principal?.kind === 'user' ? principal.id : null,
      })
      .returning();

    await this.audit.log({
      action: 'command.issue',
      principal,
      actor: principal ? undefined : issuer,
      ip,
      details: {
        cmd_id: id,
        device_id: deviceId,
        action: input.action,
        params: input.params,
        issuer,
      },
    });

    try {
      await this.mqtt.publishCommand(deviceId, {
        cmd_id: id,
        action: input.action,
        params: input.params,
      });
    } catch (err) {
      this.logger.warn(
        `Commande ${id} non publiée : ${(err as Error).message}`,
      );
      await this.finish(id, 'rejected', 'publish_failed');
      throw new ApiError('SERVICE_UNAVAILABLE', 'Broker MQTT indisponible');
    }

    this.timers.set(
      id,
      setTimeout(
        () => void this.finish(id, 'timeout').catch(() => undefined),
        ACK_TIMEOUT_MS,
      ),
    );
    this.logger.log(
      `${id} ${input.action} → ${deviceId} (${principal ? actorName(principal) : issuer})`,
    );
    return command;
  }

  /** Message cmd/ack de l'ESP. */
  async handleAck(
    deviceId: string,
    cmdId: string,
    status: 'done' | 'rejected',
    reason?: string,
  ) {
    const [command] = await this.db
      .select()
      .from(commands)
      .where(and(eq(commands.id, cmdId), eq(commands.deviceId, deviceId)))
      .limit(1);
    if (!command) {
      this.logger.warn(`Ack inconnu ${cmdId} de ${deviceId}`);
      return;
    }
    // Un ack tardif (après timeout) reste une information vraie : on l'enregistre.
    await this.finish(cmdId, status, reason ?? null);
  }

  list(deviceId: string, limit: number) {
    return this.db
      .select()
      .from(commands)
      .where(eq(commands.deviceId, deviceId))
      .orderBy(desc(commands.issuedAt))
      .limit(limit);
  }

  private async finish(
    id: string,
    status: 'done' | 'rejected' | 'timeout',
    reason: string | null = null,
  ) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    const allowedFrom: Command['status'][] =
      status === 'timeout' ? ['pending'] : ['pending', 'timeout'];
    const [updated] = await this.db
      .update(commands)
      .set({
        status,
        reason,
        ...(status === 'timeout' ? {} : { ackedAt: new Date() }),
      })
      .where(and(eq(commands.id, id), inArray(commands.status, allowedFrom)))
      .returning();
    if (updated) this.realtime.emit('command.updated', toCommandDto(updated));
  }
}
