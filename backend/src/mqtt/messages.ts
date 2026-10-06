import { z } from 'zod';

// Formats des messages ESP → backend (GUIDELINES §5.3).

const stat = <T extends z.ZodType<number>>(n: T) =>
  z
    .object({
      avg: n.nullable(),
      min: n.nullable(),
      max: n.nullable(),
      last: n.nullable().optional(),
    })
    .nullable()
    .optional();

const real = z.number().finite();
const raw = z.number().finite().min(0).max(32767);

export const TelemetryMessage = z.object({
  seq: z.number().int().nonnegative().optional(),
  uptime_ms: z.number().int().nonnegative().optional(),
  interval_s: z.number().int().min(1).max(3600),
  samples: z.number().int().min(0).max(32767),
  temperature_c: stat(real),
  humidity_pct: stat(real),
  gas_raw: stat(raw),
  // Capteur à effet Hall OH49E, valeur brute de l'ADC.
  magnetic_raw: stat(raw),
  motion_count: z.number().int().min(0).max(32767).default(0),
  ir_count: z.number().int().min(0).max(32767).default(0),
  rssi_dbm: z.number().int().min(-150).max(0).nullable().optional(),
});
export type TelemetryMessage = z.infer<typeof TelemetryMessage>;

export const EVENT_TYPES = [
  'BOOT',
  'MOTION_DETECTED',
  'IR_DETECTED',
  'IR_CLEARED',
  'GAS_RISE',
  'TAMPER',
  'SENSOR_FAILURE',
] as const;

export const EventMessage = z
  .object({
    seq: z.number().int().nonnegative().optional(),
    uptime_ms: z.number().int().nonnegative().optional(),
    type: z.enum(EVENT_TYPES),
    duration_ms: z.number().int().nonnegative().optional(),
  })
  .loose();
export type EventMessage = z.infer<typeof EventMessage>;

export const StatusMessage = z.object({
  state: z.enum(['online', 'offline']),
  fw: z.string().max(32).optional(),
  ip: z.string().max(64).optional(),
});

export const AckMessage = z.object({
  cmd_id: z.string().min(1).max(64),
  status: z.enum(['done', 'rejected']),
  reason: z.string().max(64).optional(),
});
