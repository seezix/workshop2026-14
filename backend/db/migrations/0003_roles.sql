-- Sentinel-X : rôles Postgres (GUIDELINES §7.3)
-- Les rôles sont créés sans mot de passe ni droit de connexion. Les mots de
-- passe sont posés par `npm run db:roles` à partir du .env, jamais ici.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_app') THEN
    CREATE ROLE sentinel_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_ia') THEN
    CREATE ROLE sentinel_ia NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentinel_vision') THEN
    CREATE ROLE sentinel_vision NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO sentinel_app, sentinel_ia, sentinel_vision;
--> statement-breakpoint

-- Backend : lecture et écriture sur les tables métier.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, devices, telemetry, anomaly_scores, device_events, alerts, commands,
  audit_log, persons, face_embeddings, face_sightings
TO sentinel_app;
--> statement-breakpoint
GRANT SELECT ON telemetry_1h, telemetry_1d TO sentinel_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sentinel_app;
--> statement-breakpoint

-- Service d'anomalies : lecture des mesures et agrégats, écriture dans
-- anomaly_scores uniquement.
GRANT SELECT ON devices, telemetry, telemetry_1h, telemetry_1d, device_events TO sentinel_ia;
--> statement-breakpoint
GRANT INSERT ON anomaly_scores TO sentinel_ia;
--> statement-breakpoint

-- vision.py : lecture des personnes et empreintes, écriture des passages,
-- création d'inconnus (personne + empreinte auto) et mise à jour des visites.
GRANT SELECT ON devices TO sentinel_vision;
--> statement-breakpoint
GRANT SELECT, INSERT ON persons, face_embeddings TO sentinel_vision;
--> statement-breakpoint
GRANT UPDATE (last_seen_at, visit_count, expires_at) ON persons TO sentinel_vision;
--> statement-breakpoint
GRANT INSERT ON face_sightings TO sentinel_vision;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE face_embeddings_id_seq, face_sightings_id_seq TO sentinel_vision;
