-- Sentinel-X : jeu de référence du modèle IA de prévision.
-- Mesures étiquetées (une toutes les 2 s) servant à entraîner et à évaluer le
-- modèle. Table simple et non hypertable : le jeu est figé, il n'a ni
-- compression ni rétention. Les lignes sont chargées par `npm run db:seed`
-- depuis db/seeds/model_reference_data.csv.gz, dont les colonnes deviennent :
--   Timestamp           → time (pris en UTC)
--   DHT22_Temperature_C → temp
--   DHT22_Humidity_Pct  → hum
--   Hall_Sensor_State   → hall_state (entier, 1.0 → 1, 0.0 → 0)
--   MQ2_AirQuality_ADC  → gas (valeur brute de l'ADC, comme telemetry.gas_*)
--   cluster_id          → cluster_id
--   Etat_Environnement  → label

CREATE TABLE model_reference_data (
  time       timestamptz PRIMARY KEY,
  temp       real NOT NULL,
  hum        real NOT NULL,
  hall_state smallint NOT NULL DEFAULT 1,
  gas        smallint NOT NULL,
  cluster_id smallint NOT NULL,
  label      text NOT NULL CHECK (label IN (
    'Normal', 'Pluie', 'Fuite_De_Gaz', 'Incendie', 'Evenement_Magnetique'
  ))
);
--> statement-breakpoint

-- Lecture seule pour le service IA ; le chargement se fait avec le compte
-- propriétaire.
GRANT SELECT ON model_reference_data TO sentinel_ia;
