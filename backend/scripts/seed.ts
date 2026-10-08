// Données de départ : boîtiers SX-001 (réel) et SX-SIM (simulé), compte admin,
// jeu de référence du modèle IA.
// Idempotent : peut être relancé sans effet de bord.
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { seedReferenceData } from './reference-data.js';

async function main() {
  const url = process.env.DB_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DB_ADMIN_URL ou DATABASE_URL manquant');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      INSERT INTO devices (id, name, location, is_simulated)
      VALUES ('SX-001', 'Prototype', 'Salle du workshop', false),
             ('SX-SIM', 'Boîtier simulé', 'Historique de démo', true)
      ON CONFLICT (id) DO NOTHING`);
    console.log('- boîtiers SX-001 et SX-SIM');

    const username = process.env.ADMIN_USERNAME;
    const password = process.env.ADMIN_PASSWORD;
    if (username && password) {
      if (password.length < 12)
        throw new Error('ADMIN_PASSWORD doit faire au moins 12 caractères');
      const hash = await bcrypt.hash(password, 12);
      const res = await client.query(
        `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')
         ON CONFLICT (username) DO NOTHING`,
        [username, hash],
      );
      console.log(
        res.rowCount
          ? `- compte admin « ${username} » créé`
          : `- compte « ${username} » déjà présent`,
      );
    } else {
      console.log(
        '- ADMIN_USERNAME / ADMIN_PASSWORD absents, pas de compte admin créé',
      );
    }

    const inserted = await seedReferenceData(client);
    console.log(
      inserted === null
        ? '- jeu de référence du modèle IA déjà présent'
        : `- jeu de référence du modèle IA : ${inserted} lignes`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
