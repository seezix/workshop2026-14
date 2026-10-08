-- =========================================================
-- SENTINEL-X - Reconnaissance faciale (modèle de données v0.4)
-- Peut être relancé sans danger (ne supprime rien). Sur le serveur, l'équipe a déjà
-- les tables devices et alerts : seules les parties "Reconnaissance faciale" et "Compte" servent.
-- =========================================================

-- Table minimale des boîtiers (la vraie table "devices" est créée par l'équipe)
CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY                    -- ex: 'SX-001'
);
INSERT INTO devices (id) VALUES ('SX-001') ON CONFLICT DO NOTHING;

-- Personnes (autorisées ou inconnues)
CREATE TABLE IF NOT EXISTS persons (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name  TEXT,
    status        TEXT NOT NULL CHECK (status IN ('authorized', 'unknown')),
    consent_at    TIMESTAMPTZ,
    first_seen_at TIMESTAMPTZ,
    last_seen_at  TIMESTAMPTZ,
    visit_count   INTEGER NOT NULL DEFAULT 0,
    expires_at    TIMESTAMPTZ,             -- inconnus purgés après 72 h
    created_by    UUID,                    -- FK vers la table des utilisateurs (équipe)
    CONSTRAINT authorized_needs_consent
        CHECK (status <> 'authorized' OR consent_at IS NOT NULL)
);

-- Empreintes des visages (1 à 5 par personne)
CREATE TABLE IF NOT EXISTS face_embeddings (
    id            BIGSERIAL PRIMARY KEY,
    person_id     UUID NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
    embedding     REAL[] NOT NULL CHECK (array_length(embedding, 1) = 128),
    model_version TEXT NOT NULL,
    source        TEXT NOT NULL CHECK (source IN ('enrollment', 'auto')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Alertes (remplies par l'API)
CREATE TABLE IF NOT EXISTS alerts (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id        TEXT NOT NULL REFERENCES devices(id),
    source           TEXT NOT NULL CHECK (source IN ('esp', 'vision', 'ml', 'system')),
    type             TEXT NOT NULL,                 -- ex: unknown_person, unidentified
    severity         TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'acknowledged', 'resolved')),
    message          VARCHAR(140),
    details          JSONB,
    occurrences      INTEGER NOT NULL DEFAULT 1,    -- alertes identiques regroupées
    first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged_by  UUID,                          -- FK vers "users" (table de l'équipe)
    acknowledged_at  TIMESTAMPTZ,
    resolved_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts (device_id, source, type) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_alerts_time ON alerts (last_seen_at);


-- Passages devant la caméra (1 ligne par apparition)
CREATE TABLE IF NOT EXISTS face_sightings (
    id             BIGSERIAL PRIMARY KEY,
    time           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    person_id      UUID REFERENCES persons(id) ON DELETE CASCADE,  -- vide si non identifié
    device_id      TEXT NOT NULL REFERENCES devices(id),
    similarity     REAL,
    status_at_time TEXT NOT NULL
                   CHECK (status_at_time IN ('authorized', 'unknown', 'unidentified')),
    track_id       INTEGER,
    alert_id       UUID REFERENCES alerts(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_embeddings_person ON face_embeddings (person_id);
CREATE INDEX IF NOT EXISTS idx_sightings_time    ON face_sightings (time);
CREATE INDEX IF NOT EXISTS idx_persons_expires   ON persons (expires_at) WHERE status = 'unknown';

-- Compte du programme vision : seulement les droits nécessaires
-- Remplace le mot de passe, et mets le même dans ton fichier .env (DB_PASSWORD)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vision_service') THEN
        CREATE ROLE vision_service LOGIN;
    END IF;
END $$;
ALTER ROLE vision_service PASSWORD 'vision2026';

GRANT SELECT ON persons, face_embeddings TO vision_service;
GRANT INSERT ON persons, face_embeddings, face_sightings TO vision_service;
GRANT UPDATE (last_seen_at, visit_count, expires_at) ON persons TO vision_service;
GRANT SELECT (id) ON face_sightings TO vision_service;
GRANT UPDATE (person_id, similarity, status_at_time, alert_id) ON face_sightings TO vision_service;
GRANT USAGE ON SEQUENCE face_embeddings_id_seq, face_sightings_id_seq TO vision_service;

-- Purge des inconnus expirés (à lancer régulièrement, par l'équipe) :
-- DELETE FROM persons WHERE status = 'unknown' AND expires_at < NOW();
