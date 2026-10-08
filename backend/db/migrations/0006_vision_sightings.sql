-- Sentinel-X : droits manquants de vision.py sur face_sightings.
-- vision.py écrit une ligne par apparition, relit son id (INSERT ... RETURNING id),
-- puis la met à jour quand le statut change ou qu'une alerte lui est rattachée.
-- 0003_roles.sql ne donnait que INSERT : RETURNING et UPDATE étaient refusés.

GRANT SELECT (id) ON face_sightings TO sentinel_vision;
--> statement-breakpoint
GRANT UPDATE (person_id, similarity, status_at_time, alert_id) ON face_sightings TO sentinel_vision;
