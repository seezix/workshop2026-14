// Formats renvoyés par l'API (backend/src/**/*.ts, toXxxDto). Dates en ISO 8601 UTC.

export type Role = 'viewer' | 'operator' | 'admin'
export type Severity = 'info' | 'warning' | 'critical'
export type AlertSource = 'esp' | 'vision' | 'ml' | 'system'
export type AlertStatus = 'open' | 'acknowledged' | 'resolved'
export type CommandStatus = 'pending' | 'done' | 'rejected' | 'timeout'
export type PersonStatus = 'authorized' | 'unknown' | 'denied'
export type Resolution = 'raw' | '1h' | '1d'

export interface User {
  id: string
  username: string
  role: Role
}

export interface LoginResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  user: User
}

export interface DeviceConfig {
  interval_s: number
  armed: boolean
}

export interface Device {
  id: string
  name: string | null
  location: string | null
  is_simulated: boolean
  status: 'online' | 'offline'
  fw_version: string | null
  ip: string | null
  last_seen_at: string | null
  config: DeviceConfig
  created_at: string
}

export interface Measure {
  avg: number | null
  min: number | null
  max: number | null
  last?: number | null
}

/** Point brut (telemetry) ou agrégé (telemetry_1h / telemetry_1d). */
export interface TelemetryPoint {
  time: string
  device_id: string
  seq?: number | null
  interval_s?: number
  samples: number
  temperature_c: Measure
  humidity_pct: Measure
  gas_raw: Measure
  magnetic_raw: Measure
  motion_count: number
  ir_count: number
  rssi_dbm?: number | null
}

export interface TelemetryHistory {
  device_id: string
  from: string
  to: string
  resolution: Resolution
  truncated: boolean
  points: TelemetryPoint[]
}

export interface Stats {
  device_id: string
  from: string
  to: string
  summaries: number
  samples: number
  temperature_c: Measure
  humidity_pct: Measure
  gas_raw: Measure
  magnetic_raw: Measure
  motion_count: number
  ir_count: number
  alerts: { total: number; by_severity: Record<Severity, number> }
  availability: number | null
}

export interface DeviceEvent {
  id: number | string
  time: string
  device_id: string
  seq: number | null
  uptime_ms?: number | null
  type: string
  duration_ms: number | null
  payload: Record<string, unknown> | null
}

export interface AnomalyScore {
  time: string
  device_id: string
  score: number
  is_anomaly: boolean
  model_version: string | null
  features?: unknown
}

export interface Alert {
  id: string
  device_id: string
  source: AlertSource
  type: string
  severity: Severity
  status: AlertStatus
  message: string | null
  details: Record<string, unknown> | null
  occurrences: number
  first_seen_at: string
  last_seen_at: string
  acknowledged_by: string | null
  acknowledged_at: string | null
  resolved_at: string | null
}

export type CommandInput =
  | { action: 'BUZZER'; params: { mode: 'on' | 'off' | 'beep'; duration_ms?: number } }
  | { action: 'LED'; params: { color: 'red' | 'green' | 'off'; blink?: boolean } }

export interface Command {
  cmd_id: string
  device_id: string
  action: CommandInput['action']
  params: Record<string, unknown>
  status: CommandStatus
  reason: string | null
  issuer: string
  issued_by: string | null
  issued_at: string
  acked_at: string | null
}

export interface Person {
  id: string
  display_name: string | null
  status: PersonStatus
  consent_at: string | null
  first_seen_at: string | null
  last_seen_at: string | null
  visit_count: number
  expires_at: string | null
  created_by: string | null
  embeddings_count?: number
}

export interface Sighting {
  id: number
  time: string
  person_id: string
  device_id: string | null
  similarity: number
  status_at_time: string
  track_id: number | null
  alert_id: string | null
}

export interface Health {
  status: 'ok' | 'degraded'
  api: 'up'
  database: 'up' | 'down'
  broker: 'up' | 'down' | 'disabled'
  time: string
}
