-- Sentinel-X : champ magnétique (capteur à effet Hall linéaire OH49E).
-- Valeur brute de l'ADC, comme gas_raw : au repos le capteur sort VCC/2, un
-- aimant fait monter ou descendre la valeur selon le pôle présenté.

ALTER TABLE telemetry
  ADD COLUMN mag_avg  smallint,
  ADD COLUMN mag_min  smallint,
  ADD COLUMN mag_max  smallint,
  ADD COLUMN mag_last smallint;
--> statement-breakpoint

-- Un agrégat continu ne peut pas recevoir de colonne : on les recrée. Ils se
-- recalculent depuis telemetry (lecture en temps réel, puis par la politique).
DROP MATERIALIZED VIEW telemetry_1d;
--> statement-breakpoint
DROP MATERIALIZED VIEW telemetry_1h;
--> statement-breakpoint

CREATE MATERIALIZED VIEW telemetry_1h
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 hour', time) AS bucket,
  device_id,
  sum(samples)::integer AS samples,
  sum(temp_avg * samples) FILTER (WHERE temp_avg IS NOT NULL)
    / NULLIF(sum(samples) FILTER (WHERE temp_avg IS NOT NULL), 0) AS temp_avg,
  min(temp_min) AS temp_min,
  max(temp_max) AS temp_max,
  sum(hum_avg * samples) FILTER (WHERE hum_avg IS NOT NULL)
    / NULLIF(sum(samples) FILTER (WHERE hum_avg IS NOT NULL), 0) AS hum_avg,
  min(hum_min) AS hum_min,
  max(hum_max) AS hum_max,
  sum(gas_avg::double precision * samples) FILTER (WHERE gas_avg IS NOT NULL)
    / NULLIF(sum(samples) FILTER (WHERE gas_avg IS NOT NULL), 0) AS gas_avg,
  min(gas_min) AS gas_min,
  max(gas_max) AS gas_max,
  sum(mag_avg::double precision * samples) FILTER (WHERE mag_avg IS NOT NULL)
    / NULLIF(sum(samples) FILTER (WHERE mag_avg IS NOT NULL), 0) AS mag_avg,
  min(mag_min) AS mag_min,
  max(mag_max) AS mag_max,
  sum(motion_count)::integer AS motion_count,
  sum(ir_count)::integer AS ir_count,
  sum(interval_s)::integer AS covered_s
FROM telemetry
GROUP BY bucket, device_id
WITH NO DATA;
--> statement-breakpoint

CREATE MATERIALIZED VIEW telemetry_1d
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
  time_bucket(INTERVAL '1 day', time, 'Europe/Paris') AS bucket,
  device_id,
  sum(samples)::integer AS samples,
  sum(temp_avg * samples) FILTER (WHERE temp_avg IS NOT NULL)
    / NULLIF(sum(samples) FILTER (WHERE temp_avg IS NOT NULL), 0) AS temp_avg,
  min(temp_min) AS temp_min,
  max(temp_max) AS temp_max,
  sum(hum_avg * samples) FILTER (WHERE hum_avg IS NOT NULL)
    / NULLIF(sum(samples) FILTER (WHERE hum_avg IS NOT NULL), 0) AS hum_avg,
  min(hum_min) AS hum_min,
  max(hum_max) AS hum_max,
  sum(gas_avg::double precision * samples) FILTER (WHERE gas_avg IS NOT NULL)
    / NULLIF(sum(samples) FILTER (WHERE gas_avg IS NOT NULL), 0) AS gas_avg,
  min(gas_min) AS gas_min,
  max(gas_max) AS gas_max,
  sum(mag_avg::double precision * samples) FILTER (WHERE mag_avg IS NOT NULL)
    / NULLIF(sum(samples) FILTER (WHERE mag_avg IS NOT NULL), 0) AS mag_avg,
  min(mag_min) AS mag_min,
  max(mag_max) AS mag_max,
  sum(motion_count)::integer AS motion_count,
  sum(ir_count)::integer AS ir_count,
  sum(interval_s)::integer AS covered_s
FROM telemetry
GROUP BY bucket, device_id
WITH NO DATA;
--> statement-breakpoint

SELECT add_continuous_aggregate_policy('telemetry_1h',
  start_offset => INTERVAL '3 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '30 minutes');
--> statement-breakpoint
SELECT add_continuous_aggregate_policy('telemetry_1d',
  start_offset => INTERVAL '7 days',
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '6 hours');
--> statement-breakpoint

GRANT SELECT ON telemetry_1h, telemetry_1d TO sentinel_app;
--> statement-breakpoint
GRANT SELECT ON telemetry_1h, telemetry_1d TO sentinel_ia;
