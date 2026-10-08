// Jeu de référence du modèle IA de prévision : db/seeds/model_reference_data.csv.gz
// (une mesure étiquetée toutes les 2 s) → table model_reference_data.
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';
import type pg from 'pg';

const SEED_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'db',
  'seeds',
  'model_reference_data.csv.gz',
);
const COLUMNS = [
  'DHT22_Temperature_C',
  'DHT22_Humidity_Pct',
  'Hall_Sensor_State',
  'MQ2_AirQuality_ADC',
  'cluster_id',
  'Timestamp',
  'Etat_Environnement',
] as const;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const BATCH_SIZE = 10_000;

export interface ReferenceRow {
  time: string;
  temp: number;
  hum: number;
  hallState: boolean;
  gas: number;
  clusterId: number;
  label: string;
}

function invalid(column: (typeof COLUMNS)[number], value: string): Error {
  return new Error(`${column} invalide : « ${value} »`);
}

function toNumber(column: (typeof COLUMNS)[number], value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n)) throw invalid(column, value);
  return n;
}

function toInteger(column: (typeof COLUMNS)[number], value: string): number {
  const n = toNumber(column, value);
  if (!Number.isInteger(n)) throw invalid(column, value);
  return n;
}

export function parseReferenceLine(line: string): ReferenceRow {
  const fields = line.split(',');
  if (fields.length !== COLUMNS.length)
    throw new Error(
      `${COLUMNS.length} colonnes attendues, ${fields.length} lues`,
    );
  const [temp, hum, hall, gas, cluster, timestamp, label] = fields;

  const hallState = toNumber('Hall_Sensor_State', hall);
  if (hallState !== 0 && hallState !== 1)
    throw invalid('Hall_Sensor_State', hall);
  if (!TIMESTAMP.test(timestamp)) throw invalid('Timestamp', timestamp);
  if (!label) throw invalid('Etat_Environnement', label);

  return {
    // Le CSV ne porte pas de fuseau : les horodatages sont pris en UTC.
    time: `${timestamp}+00`,
    temp: toNumber('DHT22_Temperature_C', temp),
    hum: toNumber('DHT22_Humidity_Pct', hum),
    hallState: hallState === 1,
    gas: toInteger('MQ2_AirQuality_ADC', gas),
    clusterId: toInteger('cluster_id', cluster),
    label,
  };
}

async function insertBatch(client: pg.Client, rows: ReferenceRow[]) {
  await client.query(
    `INSERT INTO model_reference_data
       (time, temp, hum, hall_state, gas, cluster_id, label)
     SELECT * FROM unnest(
       $1::timestamptz[], $2::real[], $3::real[], $4::boolean[],
       $5::smallint[], $6::smallint[], $7::text[])`,
    [
      rows.map((r) => r.time),
      rows.map((r) => r.temp),
      rows.map((r) => r.hum),
      rows.map((r) => r.hallState),
      rows.map((r) => r.gas),
      rows.map((r) => r.clusterId),
      rows.map((r) => r.label),
    ],
  );
}

// Renvoie le nombre de lignes insérées, ou null si la table est déjà remplie.
// Tout ou rien : une ligne invalide annule le chargement complet.
export async function seedReferenceData(
  client: pg.Client,
): Promise<number | null> {
  const { rows: existing } = await client.query(
    'SELECT 1 FROM model_reference_data LIMIT 1',
  );
  if (existing.length > 0) return null;

  const lines = createInterface({
    input: createReadStream(SEED_FILE).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  let inserted = 0;
  let batch: ReferenceRow[] = [];

  await client.query('BEGIN');
  try {
    for await (const raw of lines) {
      lineNumber++;
      if (lineNumber === 1) {
        if (raw.replace(/^﻿/, '') !== COLUMNS.join(','))
          throw new Error(`en-tête inattendu : « ${raw} »`);
        continue;
      }
      if (raw === '') continue;
      try {
        batch.push(parseReferenceLine(raw));
      } catch (err) {
        throw new Error(`ligne ${lineNumber} : ${(err as Error).message}`);
      }
      if (batch.length === BATCH_SIZE) {
        await insertBatch(client, batch);
        inserted += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await insertBatch(client, batch);
      inserted += batch.length;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  return inserted;
}
