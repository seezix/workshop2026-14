import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Access, CurrentPrincipal, type Principal } from '../auth/access.js';
import { ZodPipe, zDeviceId, zIsoDate } from '../common/zod.pipe.js';
import {
  type CommandInput,
  CommandSchema,
  CommandsService,
  toCommandDto,
} from '../commands/commands.service.js';
import { TelemetryService } from '../telemetry/telemetry.service.js';
import { DevicesService, toDeviceDto } from './devices.service.js';

const DAY_MS = 24 * 3600 * 1000;

const limit = (def: number, max: number) =>
  z.coerce.number().int().min(1).max(max).default(def);

const periodFields = { from: zIsoDate.optional(), to: zIsoDate.optional() };

/** 24 dernières heures par défaut. */
function resolvePeriod(from?: Date, to?: Date) {
  const end = to ?? new Date();
  return { from: from ?? new Date(end.getTime() - DAY_MS), to: end };
}

const validPeriod: [
  (v: { period: { from: Date; to: Date } }) => boolean,
  { message: string; path: string[] },
] = [
  (v) => v.period.from < v.period.to,
  { message: 'from doit précéder to', path: ['from'] },
];

const PeriodQuery = z
  .object(periodFields)
  .transform(({ from, to }) => ({ period: resolvePeriod(from, to) }))
  .refine(...validPeriod);

const TelemetryQuery = z
  .object({
    ...periodFields,
    resolution: z.enum(['raw', '1h', '1d']).optional(),
  })
  .transform(({ from, to, resolution }) => ({
    resolution,
    period: resolvePeriod(from, to),
  }))
  .refine(...validPeriod);

const EventsQuery = z
  .object({
    ...periodFields,
    type: z
      .string()
      .regex(/^[A-Z_]{2,32}$/)
      .optional(),
    limit: limit(100, 1000),
  })
  .transform(({ from, to, type, limit }) => ({
    type,
    limit,
    period: resolvePeriod(from, to),
  }))
  .refine(...validPeriod);

const ScoresQuery = z
  .object({ ...periodFields, limit: limit(500, 10_000) })
  .transform(({ from, to, limit }) => ({
    limit,
    period: resolvePeriod(from, to),
  }))
  .refine(...validPeriod);

const ConfigBody = z
  .object({
    interval_s: z.number().int().min(2).max(300).optional(),
    armed: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.interval_s !== undefined || b.armed !== undefined, {
    message: 'interval_s ou armed attendu',
  });

const id = new ZodPipe(zDeviceId);

@Controller('devices')
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly telemetry: TelemetryService,
    private readonly commands: CommandsService,
  ) {}

  @Get()
  async list() {
    return (await this.devices.list()).map(toDeviceDto);
  }

  @Get(':id')
  async get(@Param('id', id) deviceId: string) {
    return toDeviceDto(await this.devices.get(deviceId));
  }

  @Put(':id/config')
  @Access({ role: 'operator' })
  async updateConfig(
    @Param('id', id) deviceId: string,
    @Body(new ZodPipe(ConfigBody)) body: z.infer<typeof ConfigBody>,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ) {
    const device = await this.devices.updateConfig(
      deviceId,
      body,
      principal,
      req.ip,
    );
    return toDeviceDto(device);
  }

  @Get(':id/telemetry')
  @Access({ role: 'viewer', services: true })
  async history(
    @Param('id', id) deviceId: string,
    @Query(new ZodPipe(TelemetryQuery)) q: z.infer<typeof TelemetryQuery>,
  ) {
    await this.devices.get(deviceId);
    const result = await this.telemetry.history(
      deviceId,
      q.period,
      q.resolution,
    );
    return {
      device_id: deviceId,
      from: q.period.from,
      to: q.period.to,
      ...result,
    };
  }

  @Get(':id/telemetry/export')
  @Access({ role: 'viewer', services: true })
  async export(
    @Param('id', id) deviceId: string,
    @Query(new ZodPipe(TelemetryQuery)) q: z.infer<typeof TelemetryQuery>,
    @Res() res: Response,
  ) {
    await this.devices.get(deviceId);
    const body = await this.telemetry.csv(deviceId, q.period, q.resolution);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    res
      .status(200)
      .type('text/csv; charset=utf-8')
      .setHeader(
        'Content-Disposition',
        `attachment; filename="${deviceId}_${day(q.period.from)}_${day(q.period.to)}.csv"`,
      )
      .send(body);
  }

  @Get(':id/stats')
  async stats(
    @Param('id', id) deviceId: string,
    @Query(new ZodPipe(PeriodQuery)) q: z.infer<typeof PeriodQuery>,
  ) {
    await this.devices.get(deviceId);
    return this.telemetry.stats(deviceId, q.period);
  }

  @Get(':id/events')
  async events(
    @Param('id', id) deviceId: string,
    @Query(new ZodPipe(EventsQuery)) q: z.infer<typeof EventsQuery>,
  ) {
    await this.devices.get(deviceId);
    return this.telemetry.events(deviceId, q.period, q.type, q.limit);
  }

  @Get(':id/anomaly-scores')
  async anomalyScores(
    @Param('id', id) deviceId: string,
    @Query(new ZodPipe(ScoresQuery)) q: z.infer<typeof ScoresQuery>,
  ) {
    await this.devices.get(deviceId);
    return this.telemetry.anomalyScores(deviceId, q.period, q.limit);
  }

  @Post(':id/commands')
  @Access({ role: 'operator' })
  @HttpCode(202)
  async sendCommand(
    @Param('id', id) deviceId: string,
    @Body(new ZodPipe(CommandSchema)) body: CommandInput,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ) {
    const command = await this.commands.issue(
      deviceId,
      body,
      'user',
      principal,
      req.ip,
    );
    return { cmd_id: command.id, status: command.status };
  }

  @Get(':id/commands')
  async listCommands(
    @Param('id', id) deviceId: string,
    @Query(new ZodPipe(z.object({ limit: limit(50, 500) })))
    q: { limit: number },
  ) {
    await this.devices.get(deviceId);
    return (await this.commands.list(deviceId, q.limit)).map(toCommandDto);
  }
}
