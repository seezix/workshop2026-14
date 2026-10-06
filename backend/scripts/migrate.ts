// Applique les migrations SQL de db/migrations dans l'ordre.
// À lancer avec le compte propriétaire de la base (POSTGRES_USER), pas avec
// sentinel_app : DB_ADMIN_URL, sinon DATABASE_URL.
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'db',
  'migrations',
);
const BREAKPOINT = '--> statement-breakpoint';

async function main() {
  const url = process.env.DB_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DB_ADMIN_URL ou DATABASE_URL manquant');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string }>(
      'SELECT name FROM schema_migrations',
    );
    const applied = new Set(rows.map((r) => r.name));

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const statements = sql
        .split(BREAKPOINT)
        .map((s) => s.trim())
        .filter((s) => s.replace(/--.*$/gm, '').trim().length > 0);
      console.log(`→ ${file} (${statements.length} instructions)`);
      // Pas de transaction globale : les agrégats continus de TimescaleDB ne
      // peuvent pas être créés dans un bloc de transaction.
      for (const statement of statements) {
        await client.query(statement);
      }
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
        file,
      ]);
    }
    console.log('Migrations à jour.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
