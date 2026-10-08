-- Sentinel-X : agrégats continus, compression, rétention (GUIDELINES §7.2)
-- Prisma/Drizzle ne gèrent pas Timescale : tout est ici en SQL brut.

-- Agrégat horaire. Moyennes pondérées par samples, min des min, max des max,
-- somme des compteurs.
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
  sum(motion_count)::integer AS motion_count,
  sum(ir_count)::integer AS ir_count,
  sum(interval_s)::integer AS covered_s
FROM telemetry
GROUP BY bucket, device_id
WITH NO DATA;
--> statement-breakpoint

-- Agrégat journalier, jour calé sur Europe/Paris.
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

-- Compression après 7 jours, rétention 365 jours.
ALTER TABLE telemetry SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id',
  timescaledb.compress_orderby = 'time DESC'
);
--> statement-breakpoint
SELECT add_compression_policy('telemetry', INTERVAL '7 days');
--> statement-breakpoint
SELECT add_retention_policy('telemetry', INTERVAL '365 days');
--> statement-breakpoint

-- Le service d'anomalies écrit directement dans anomaly_scores : on prévient
-- le backend par NOTIFY pour qu'il pousse l'événement SSE anomaly.score.
CREATE FUNCTION notify_anomaly_score() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('anomaly_score', json_build_object(
    'time', NEW.time,
    'device_id', NEW.device_id,
    'score', NEW.score,
    'is_anomaly', NEW.is_anomaly,
    'model_version', NEW.model_version
  )::text);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER anomaly_scores_notify
AFTER INSERT ON anomaly_scores
FOR EACH ROW EXECUTE FUNCTION notify_anomaly_score();
