// Miroir TypeScript de db/migrations (source de vérité : le SQL).
import {
  bigint,
  boolean,
  inet,
  integer,
  jsonb,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const tz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['viewer', 'operator', 'admin'] }).notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
  lastLoginAt: tz('last_login_at'),
});

export const devices = pgTable('devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  location: text('location'),
  isSimulated: boolean('is_simulated').notNull(),
  status: text('status', { enum: ['online', 'offline'] }).notNull(),
  fwVersion: text('fw_version'),
  ip: inet('ip'),
  lastSeenAt: tz('last_seen_at'),
  intervalS: smallint('interval_s').notNull(),
  armed: boolean('armed').notNull(),
  createdAt: tz('created_at').notNull().defaultNow(),
});

export const telemetry = pgTable('telemetry', {
  time: tz('time').notNull(),
  deviceId: text('device_id').notNull(),
  seq: integer('seq'),
  uptimeMs: bigint('uptime_ms', { mode: 'number' }),
  intervalS: smallint('interval_s').notNull(),
  samples: smallint('samples').notNull(),
  tempAvg: real('temp_avg'),
  tempMin: real('temp_min'),
  tempMax: real('temp_max'),
  tempLast: real('temp_last'),
  humAvg: real('hum_avg'),
  humMin: real('hum_min'),
  humMax: real('hum_max'),
  humLast: real('hum_last'),
  gasAvg: smallint('gas_avg'),
  gasMin: smallint('gas_min'),
  gasMax: smallint('gas_max'),
  gasLast: smallint('gas_last'),
  motionCount: smallint('motion_count').notNull(),
  irCount: smallint('ir_count').notNull(),
  rssiDbm: smallint('rssi_dbm'),
});

export const anomalyScores = pgTable('anomaly_scores', {
  time: tz('time').notNull(),
  deviceId: text('device_id').notNull(),
  score: real('score').notNull(),
  isAnomaly: boolean('is_anomaly').notNull(),
  modelVersion: text('model_version').notNull(),
  features: jsonb('features'),
});

export const deviceEvents = pgTable('device_events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  time: tz('time').notNull(),
  deviceId: text('device_id').notNull(),
  seq: integer('seq'),
  uptimeMs: bigint('uptime_ms', { mode: 'number' }),
  type: text('type').notNull(),
  durationMs: integer('duration_ms'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
});

export const alerts = pgTable('alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  deviceId: text('device_id').notNull(),
  source: text('source', { enum: ['esp', 'vision', 'ml', 'system'] }).notNull(),
  type: text('type').notNull(),
  severity: text('severity', {
    enum: ['info', 'warning', 'critical'],
  }).notNull(),
  status: text('status', {
    enum: ['open', 'acknowledged', 'resolved'],
  }).notNull(),
  message: text('message'),
  details: jsonb('details').$type<Record<string, unknown>>().notNull(),
  occurrences: integer('occurrences').notNull(),
  firstSeenAt: tz('first_seen_at').notNull(),
  lastSeenAt: tz('last_seen_at').notNull(),
  acknowledgedBy: uuid('acknowledged_by'),
  acknowledgedAt: tz('acknowledged_at'),
  resolvedAt: tz('resolved_at'),
});

export const commands = pgTable('commands', {
  id: text('id').primaryKey(),
  deviceId: text('device_id').notNull(),
  action: text('action', { enum: ['BUZZER', 'LED'] }).notNull(),
  params: jsonb('params').$type<Record<string, unknown>>().notNull(),
  status: text('status', {
    enum: ['pending', 'done', 'rejected', 'timeout'],
  }).notNull(),
  reason: text('reason'),
  issuer: text('issuer').notNull(),
  issuedBy: uuid('issued_by'),
  issuedAt: tz('issued_at').notNull().defaultNow(),
  ackedAt: tz('acked_at'),
});

export const auditLog = pgTable('audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  time: tz('time').notNull().defaultNow(),
  userId: uuid('user_id'),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  ip: inet('ip'),
  details: jsonb('details').$type<Record<string, unknown>>().notNull(),
});

export const persons = pgTable('persons', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name'),
  status: text('status', {
    enum: ['authorized', 'unknown', 'denied'],
  }).notNull(),
  consentAt: tz('consent_at'),
  firstSeenAt: tz('first_seen_at').notNull(),
  lastSeenAt: tz('last_seen_at').notNull(),
  visitCount: integer('visit_count').notNull(),
  expiresAt: tz('expires_at'),
  createdBy: uuid('created_by'),
});

// Les empreintes ne sont jamais lues par l'API : seul leur nombre est exposé.
export const faceEmbeddings = pgTable('face_embeddings', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  personId: uuid('person_id').notNull(),
  modelVersion: text('model_version').notNull(),
  source: text('source', { enum: ['enrollment', 'auto'] }).notNull(),
  createdAt: tz('created_at').notNull(),
});

export const faceSightings = pgTable('face_sightings', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  time: tz('time').notNull(),
  personId: uuid('person_id').notNull(),
  deviceId: text('device_id'),
  similarity: real('similarity').notNull(),
  statusAtTime: text('status_at_time').notNull(),
  trackId: integer('track_id'),
  alertId: uuid('alert_id'),
});

export type Device = typeof devices.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type Command = typeof commands.$inferSelect;
export type User = typeof users.$inferSelect;
export type Role = User['role'];
