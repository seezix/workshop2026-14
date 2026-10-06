-- Sentinel-X : tables métier (docs/schema-bdd.puml v0.4.1)
-- Les instructions sont séparées par des marqueurs « statement-breakpoint » :
-- le script de migration les exécute une par une (TimescaleDB refuse
-- certaines commandes dans un bloc de transaction).

CREATE EXTENSION IF NOT EXISTS timescaledb;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint

-- Référentiel ---------------------------------------------------------------

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
--> statement-breakpoint

CREATE TABLE devices (
  id           text PRIMARY KEY CHECK (id ~ '^SX-[A-Z0-9]{3,16}$'),
  name         text NOT NULL,
  location     text,
  is_simulated boolean NOT NULL DEFAULT false,
  status       text NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
  fw_version   text,
  ip           inet,
  last_seen_at timestamptz,
  interval_s   smallint NOT NULL DEFAULT 60 CHECK (interval_s BETWEEN 2 AND 300),
  armed        boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Séries temporelles ---------------------------------------------------------

CREATE TABLE telemetry (
  time         timestamptz NOT NULL,
  device_id    text NOT NULL REFERENCES devices (id),
  seq          integer,
  uptime_ms    bigint,
  interval_s   smallint NOT NULL,
  samples      smallint NOT NULL,
  temp_avg     real,
  temp_min     real,
  temp_max     real,
  temp_last    real,
  hum_avg      real,
  hum_min      real,
  hum_max      real,
  hum_last     real,
  gas_avg      smallint,
  gas_min      smallint,
  gas_max      smallint,
  gas_last     smallint,
  motion_count smallint NOT NULL DEFAULT 0,
  ir_count     smallint NOT NULL DEFAULT 0,
  rssi_dbm     smallint
);
--> statement-breakpoint
SELECT create_hypertable('telemetry', by_range('time', INTERVAL '1 day'));
--> statement-breakpoint
CREATE INDEX telemetry_device_time_idx ON telemetry (device_id, time DESC);
--> statement-breakpoint

CREATE TABLE anomaly_scores (
  time          timestamptz NOT NULL,
  device_id     text NOT NULL REFERENCES devices (id),
  score         real NOT NULL,
  is_anomaly    boolean NOT NULL,
  model_version text NOT NULL,
  features      jsonb
);
--> statement-breakpoint
SELECT create_hypertable('anomaly_scores', by_range('time', INTERVAL '7 days'));
--> statement-breakpoint
CREATE INDEX anomaly_scores_device_time_idx ON anomaly_scores (device_id, time DESC);
--> statement-breakpoint

-- Événements, alertes et actions ----------------------------------------------

CREATE TABLE device_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  time        timestamptz NOT NULL,
  device_id   text NOT NULL REFERENCES devices (id),
  seq         integer,
  uptime_ms   bigint,
  type        text NOT NULL,
  duration_ms integer,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE INDEX device_events_device_time_idx ON device_events (device_id, time DESC);
--> statement-breakpoint
CREATE INDEX device_events_type_time_idx ON device_events (device_id, type, time DESC);
--> statement-breakpoint

CREATE TABLE alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id       text NOT NULL REFERENCES devices (id),
  source          text NOT NULL CHECK (source IN ('esp', 'vision', 'ml', 'system')),
  type            text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  message         text CHECK (char_length(message) <= 140),
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurrences     integer NOT NULL DEFAULT 1,
  first_seen_at   timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  acknowledged_by uuid REFERENCES users (id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  resolved_at     timestamptz
);
--> statement-breakpoint
CREATE INDEX alerts_status_last_seen_idx ON alerts (status, last_seen_at DESC);
--> statement-breakpoint
CREATE INDEX alerts_dedup_idx ON alerts (device_id, source, type, last_seen_at DESC);
--> statement-breakpoint

CREATE TABLE commands (
  id        text PRIMARY KEY,
  device_id text NOT NULL REFERENCES devices (id),
  action    text NOT NULL CHECK (action IN ('BUZZER', 'LED')),
  params    jsonb NOT NULL DEFAULT '{}'::jsonb,
  status    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'rejected', 'timeout')),
  reason    text,
  issuer    text NOT NULL CHECK (issuer = 'user' OR issuer ~ '^(rule|service):[a-z0-9_-]+$'),
  issued_by uuid REFERENCES users (id) ON DELETE SET NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  acked_at  timestamptz,
  -- issued_by est renseigné à l'envoi quand issuer = user (il peut repasser
  -- à NULL si le compte est supprimé, d'où l'absence de contrainte stricte).
  CHECK (issuer = 'user' OR issued_by IS NULL)
);
--> statement-breakpoint
CREATE INDEX commands_device_issued_idx ON commands (device_id, issued_at DESC);
--> statement-breakpoint

CREATE TABLE audit_log (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  time    timestamptz NOT NULL DEFAULT now(),
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  actor   text NOT NULL,
  action  text NOT NULL,
  ip      inet,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE INDEX audit_log_time_idx ON audit_log (time DESC);
--> statement-breakpoint

-- Reconnaissance faciale (données biométriques, art. 9 RGPD) ------------------

CREATE TABLE persons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  text,
  status        text NOT NULL DEFAULT 'unknown' CHECK (status IN ('authorized', 'unknown', 'denied')),
  consent_at    timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  visit_count   integer NOT NULL DEFAULT 1,
  expires_at    timestamptz,
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  -- authorized = consentement obligatoire
  CHECK (status <> 'authorized' OR consent_at IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX persons_unknown_expiry_idx ON persons (expires_at) WHERE status = 'unknown';
--> statement-breakpoint

CREATE TABLE face_embeddings (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person_id     uuid NOT NULL REFERENCES persons (id) ON DELETE CASCADE,
  embedding     real[] NOT NULL CHECK (array_length(embedding, 1) = 128),
  model_version text NOT NULL,
  source        text NOT NULL CHECK (source IN ('enrollment', 'auto')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX face_embeddings_person_idx ON face_embeddings (person_id);
--> statement-breakpoint

CREATE TABLE face_sightings (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  time           timestamptz NOT NULL,
  person_id      uuid NOT NULL REFERENCES persons (id) ON DELETE CASCADE,
  device_id      text REFERENCES devices (id),
  similarity     real NOT NULL,
  status_at_time text NOT NULL,
  track_id       integer,
  alert_id       uuid REFERENCES alerts (id) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX face_sightings_person_time_idx ON face_sightings (person_id, time DESC);
