-- Sentinel-X : model_reference_data.hall_state en entier (0 ou 1) et non plus
-- en booléen, comme Hall_Sensor_State du CSV : le service IA s'en sert
-- directement comme variable numérique du modèle.
--   1 = capteur au repos, 0 = aimant détecté

ALTER TABLE model_reference_data
  ALTER COLUMN hall_state TYPE smallint USING hall_state::integer,
  ADD CONSTRAINT model_reference_data_hall_state_check CHECK (hall_state IN (0, 1));
