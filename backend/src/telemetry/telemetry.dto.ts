import type { telemetry } from '../db/schema.js';

type TelemetryRow = typeof telemetry.$inferSelect;

/** Ligne brute → format de l'API, aligné sur le message MQTT (§5.3). */
export function toTelemetryDto(r: TelemetryRow) {
  return {
    time: r.time,
    device_id: r.deviceId,
    seq: r.seq,
    interval_s: r.intervalS,
    samples: r.samples,
    temperature_c: {
      avg: r.tempAvg,
      min: r.tempMin,
      max: r.tempMax,
      last: r.tempLast,
    },
    humidity_pct: {
      avg: r.humAvg,
      min: r.humMin,
      max: r.humMax,
      last: r.humLast,
    },
    gas_raw: { avg: r.gasAvg, min: r.gasMin, max: r.gasMax, last: r.gasLast },
    magnetic_raw: {
      avg: r.magAvg,
      min: r.magMin,
      max: r.magMax,
      last: r.magLast,
    },
    motion_count: r.motionCount,
    ir_count: r.irCount,
    rssi_dbm: r.rssiDbm,
  };
}

export type Resolution = 'raw' | '1h' | '1d';

const DAY_MS = 24 * 3600 * 1000;

/** Brut jusqu'à 24 h, telemetry_1h jusqu'à 30 jours, telemetry_1d au-delà (§7.2). */
export function pickResolution(from: Date, to: Date): Resolution {
  const span = to.getTime() - from.getTime();
  if (span <= DAY_MS) return 'raw';
  if (span <= 30 * DAY_MS) return '1h';
  return '1d';
}
