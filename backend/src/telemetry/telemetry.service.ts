import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { ApiError } from '../common/api-error.js';
import { DB, type Database } from '../db/database.module.js';
import { anomalyScores, deviceEvents, telemetry } from '../db/schema.js';
import { pickResolution, Resolution, toTelemetryDto } from './telemetry.dto.js';

export const MAX_POINTS = 50_000;
const MAX_RAW_SPAN_MS = 31 * 24 * 3600 * 1000;

export interface Period {
  from: Date;
  to: Date;
}

type AggRow = {
  bucket: Date;
  device_id: string;
  samples: number;
  temp_avg: number | null;
  temp_min: number | null;
  temp_max: number | null;
  hum_avg: number | null;
  hum_min: number | null;
  hum_max: number | null;
  gas_avg: number | null;
  gas_min: number | null;
  gas_max: number | null;
  motion_count: number;
  ir_count: number;
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const round1 = (v: unknown) =>
  v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10;

function toAggDto(r: AggRow) {
  return {
    time: new Date(r.bucket),
    device_id: r.device_id,
    samples: Number(r.samples),
    temperature_c: {
      avg: round1(r.temp_avg),
      min: num(r.temp_min),
      max: num(r.temp_max),
    },
    humidity_pct: {
      avg: round1(r.hum_avg),
      min: num(r.hum_min),
      max: num(r.hum_max),
    },
    gas_raw: {
      avg: round1(r.gas_avg),
      min: num(r.gas_min),
      max: num(r.gas_max),
    },
    motion_count: Number(r.motion_count),
    ir_count: Number(r.ir_count),
  };
}

@Injectable()
export class TelemetryService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async history(deviceId: string, period: Period, forced?: Resolution) {
    const resolution = forced ?? pickResolution(period.from, period.to);
    if (
      resolution === 'raw' &&
      period.to.getTime() - period.from.getTime() > MAX_RAW_SPAN_MS
    ) {
      throw new ApiError(
        'VALIDATION_ERROR',
        'Période trop longue pour des données brutes (31 jours max)',
      );
    }

    if (resolution === 'raw') {
      const rows = await this.db
        .select()
        .from(telemetry)
        .where(
          and(
            eq(telemetry.deviceId, deviceId),
            gte(telemetry.time, period.from),
            lt(telemetry.time, period.to),
          ),
        )
        .orderBy(asc(telemetry.time))
        .limit(MAX_POINTS + 1);
      return {
        resolution,
        truncated: rows.length > MAX_POINTS,
        points: rows.slice(0, MAX_POINTS).map(toTelemetryDto),
      };
    }

    // Les agrégats continus ne sont pas dans le schéma Drizzle : SQL direct.
    const view =
      resolution === '1h' ? sql.raw('telemetry_1h') : sql.raw('telemetry_1d');
    const { rows } = await this.db.execute<AggRow>(sql`
      SELECT bucket, device_id, samples, temp_avg, temp_min, temp_max, hum_avg, hum_min, hum_max,
             gas_avg, gas_min, gas_max, motion_count, ir_count
      FROM ${view}
      WHERE device_id = ${deviceId} AND bucket >= ${period.from} AND bucket < ${period.to}
      ORDER BY bucket
      LIMIT ${MAX_POINTS + 1}`);
    return {
      resolution,
      truncated: rows.length > MAX_POINTS,
      points: rows.slice(0, MAX_POINTS).map(toAggDto),
    };
  }

  /** Résumé d'une période : moyennes pondérées, extrêmes, alertes, disponibilité. */
  async stats(deviceId: string, period: Period) {
    const end = new Date(Math.min(period.to.getTime(), Date.now()));
    const { rows } = await this.db.execute<Record<string, unknown>>(sql`
      SELECT
        count(*)::integer AS summaries,
        coalesce(sum(samples), 0)::integer AS samples,
        sum(temp_avg * samples) FILTER (WHERE temp_avg IS NOT NULL)
          / NULLIF(sum(samples) FILTER (WHERE temp_avg IS NOT NULL), 0) AS temp_avg,
        min(temp_min) AS temp_min, max(temp_max) AS temp_max,
        sum(hum_avg * samples) FILTER (WHERE hum_avg IS NOT NULL)
          / NULLIF(sum(samples) FILTER (WHERE hum_avg IS NOT NULL), 0) AS hum_avg,
        min(hum_min) AS hum_min, max(hum_max) AS hum_max,
        sum(gas_avg::double precision * samples) FILTER (WHERE gas_avg IS NOT NULL)
          / NULLIF(sum(samples) FILTER (WHERE gas_avg IS NOT NULL), 0) AS gas_avg,
        min(gas_min) AS gas_min, max(gas_max) AS gas_max,
        coalesce(sum(motion_count), 0)::integer AS motion_count,
        coalesce(sum(ir_count), 0)::integer AS ir_count,
        coalesce(sum(interval_s), 0)::bigint AS covered_s
      FROM telemetry
      WHERE device_id = ${deviceId} AND time >= ${period.from} AND time < ${period.to}`);
    const s = rows[0];

    const alertRows = await this.db.execute<{
      severity: string;
      count: number;
    }>(sql`
      SELECT severity, count(*)::integer AS count
      FROM alerts
      WHERE device_id = ${deviceId} AND first_seen_at >= ${period.from} AND first_seen_at < ${period.to}
      GROUP BY severity`);
    const bySeverity = { info: 0, warning: 0, critical: 0 } as Record<
      string,
      number
    >;
    for (const r of alertRows.rows) bySeverity[r.severity] = Number(r.count);

    const periodS = Math.max((end.getTime() - period.from.getTime()) / 1000, 0);
    return {
      device_id: deviceId,
      from: period.from,
      to: period.to,
      summaries: Number(s.summaries),
      samples: Number(s.samples),
      temperature_c: {
        avg: round1(s.temp_avg),
        min: num(s.temp_min),
        max: num(s.temp_max),
      },
      humidity_pct: {
        avg: round1(s.hum_avg),
        min: num(s.hum_min),
        max: num(s.hum_max),
      },
      gas_raw: {
        avg: round1(s.gas_avg),
        min: num(s.gas_min),
        max: num(s.gas_max),
      },
      motion_count: Number(s.motion_count),
      ir_count: Number(s.ir_count),
      alerts: {
        total: bySeverity.info + bySeverity.warning + bySeverity.critical,
        by_severity: bySeverity,
      },
      // Part de la période couverte par des résumés reçus.
      availability:
        periodS > 0
          ? Math.min(
              1,
              Math.round((Number(s.covered_s) / periodS) * 1000) / 1000,
            )
          : null,
    };
  }

  async csv(
    deviceId: string,
    period: Period,
    forced?: Resolution,
  ): Promise<string> {
    const { points } = await this.history(deviceId, period, forced);
    const header = [
      'time',
      'device_id',
      'samples',
      'temperature_c_avg',
      'temperature_c_min',
      'temperature_c_max',
      'humidity_pct_avg',
      'humidity_pct_min',
      'humidity_pct_max',
      'gas_raw_avg',
      'gas_raw_min',
      'gas_raw_max',
      'motion_count',
      'ir_count',
    ];
    const cell = (v: unknown) =>
      v === null || v === undefined ? '' : String(v);
    const lines = points.map((p) =>
      [
        p.time.toISOString(),
        p.device_id,
        p.samples,
        p.temperature_c.avg,
        p.temperature_c.min,
        p.temperature_c.max,
        p.humidity_pct.avg,
        p.humidity_pct.min,
        p.humidity_pct.max,
        p.gas_raw.avg,
        p.gas_raw.min,
        p.gas_raw.max,
        p.motion_count,
        p.ir_count,
      ]
        .map(cell)
        .join(','),
    );
    return [header.join(','), ...lines].join('\n') + '\n';
  }

  async events(
    deviceId: string,
    period: Period,
    type: string | undefined,
    limit: number,
  ) {
    const rows = await this.db
      .select()
      .from(deviceEvents)
      .where(
        and(
          eq(deviceEvents.deviceId, deviceId),
          gte(deviceEvents.time, period.from),
          lt(deviceEvents.time, period.to),
          type ? eq(deviceEvents.type, type) : undefined,
        ),
      )
      .orderBy(desc(deviceEvents.time))
      .limit(limit);
    return rows.map((e) => ({
      id: e.id,
      time: e.time,
      device_id: e.deviceId,
      seq: e.seq,
      uptime_ms: e.uptimeMs,
      type: e.type,
      duration_ms: e.durationMs,
      payload: e.payload,
    }));
  }

  async anomalyScores(deviceId: string, period: Period, limit: number) {
    const rows = await this.db
      .select()
      .from(anomalyScores)
      .where(
        and(
          eq(anomalyScores.deviceId, deviceId),
          gte(anomalyScores.time, period.from),
          lt(anomalyScores.time, period.to),
        ),
      )
      .orderBy(desc(anomalyScores.time))
      .limit(limit);
    return rows.map((r) => ({
      time: r.time,
      device_id: r.deviceId,
      score: r.score,
      is_anomaly: r.isAnomaly,
      model_version: r.modelVersion,
      features: r.features,
    }));
  }
}
