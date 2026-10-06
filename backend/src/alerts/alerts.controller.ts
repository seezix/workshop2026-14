import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Access, CurrentPrincipal, type Principal } from '../auth/access.js';
import { RateLimit } from '../common/rate-limit.js';
import { ZodPipe, zDeviceId, zIsoDate, zUuid } from '../common/zod.pipe.js';
import { ALERT_TYPES, AlertsService, toAlertDto } from './alerts.service.js';

const SOURCES = ['esp', 'vision', 'ml', 'system'] as const;
const SEVERITIES = ['info', 'warning', 'critical'] as const;

const AlertBody = z
  .object({
    device_id: zDeviceId,
    source: z.enum(SOURCES),
    type: z.string(),
    severity: z.enum(SEVERITIES),
    occurred_at: zIsoDate.optional(),
    message: z.string().max(140).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .refine((b) => ALERT_TYPES[b.source].includes(b.type), {
    message: 'type inconnu pour cette source',
    path: ['type'],
  })
  .refine((b) => !b.details || JSON.stringify(b.details).length <= 4096, {
    message: 'details trop volumineux (4 Ko max)',
    path: ['details'],
  })
  // Une horloge de service déréglée ne doit pas dater une alerte dans le futur.
  .transform((b) => ({
    ...b,
    occurred_at:
      b.occurred_at && b.occurred_at.getTime() <= Date.now() + 5_000
        ? b.occurred_at
        : new Date(),
  }));

const ListQuery = z.object({
  status: z.enum(['open', 'acknowledged', 'resolved']).optional(),
  device_id: zDeviceId.optional(),
  source: z.enum(SOURCES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const PatchBody = z
  .object({ status: z.enum(['acknowledged', 'resolved']) })
  .strict();

@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  async list(@Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>) {
    return (await this.alerts.list(q)).map(toAlertDto);
  }

  /**
   * Point d'entrée unique des alertes des services (vision.py, anomalies).
   * 201 : nouvelle alerte ; 200 : doublon (occurrences + 1) ou détection
   * ignorée car le boîtier est désarmé.
   */
  @Post()
  @Access({ services: true })
  @RateLimit({ limit: 10, windowMs: 1_000, by: 'principal' })
  async create(
    @Body(new ZodPipe(AlertBody)) body: z.infer<typeof AlertBody>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.alerts.ingest(body);
    if (result.outcome === 'suppressed') {
      res.status(200);
      return { alert: null, suppressed: true, reason: result.reason };
    }
    res.status(result.outcome === 'created' ? 201 : 200);
    return toAlertDto(result.alert);
  }

  @Patch(':id')
  @Access({ role: 'operator' })
  async update(
    @Param('id', new ZodPipe(zUuid)) id: string,
    @Body(new ZodPipe(PatchBody)) body: z.infer<typeof PatchBody>,
    @CurrentPrincipal() principal: Principal,
    @Req() req: Request,
  ) {
    return toAlertDto(
      await this.alerts.updateStatus(id, body.status, principal, req.ip),
    );
  }
}
