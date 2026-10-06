import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import pg from 'pg';
import { Public } from '../auth/access.js';
import { PG_POOL } from '../db/database.module.js';
import { MqttService } from '../mqtt/mqtt.service.js';

/** État API, base, broker. Exposé au réseau local uniquement (nginx). */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly mqtt: MqttService,
  ) {}

  @Get()
  @Public()
  async health(@Res({ passthrough: true }) res: Response) {
    let database = 'down';
    try {
      await this.pool.query('SELECT 1');
      database = 'up';
    } catch {
      /* base injoignable */
    }
    const broker = !this.mqtt.enabled
      ? 'disabled'
      : this.mqtt.connected
        ? 'up'
        : 'down';
    const ok = database === 'up' && broker !== 'down';
    res.status(ok ? 200 : 503);
    return {
      status: ok ? 'ok' : 'degraded',
      api: 'up',
      database,
      broker,
      time: new Date(),
    };
  }
}
