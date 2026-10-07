// Pose les mots de passe des rôles Postgres à partir du .env (GUIDELINES §7.3).
// Un rôle sans variable définie reste NOLOGIN.
import pg from 'pg';

const ROLES: Record<string, string> = {
  sentinel_app: 'DB_APP_PASSWORD',
  sentinel_ia: 'DB_IA_PASSWORD',
  sentinel_vision: 'DB_VISION_PASSWORD',
};

async function main() {
  const url = process.env.DB_ADMIN_URL;
  if (!url)
    throw new Error('DB_ADMIN_URL manquant (compte propriétaire de la base)');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const [role, envVar] of Object.entries(ROLES)) {
      const password = process.env[envVar];
      if (!password) {
        console.log(`- ${role} : ${envVar} absent, rôle laissé sans connexion`);
        continue;
      }
      if (password.length < 16)
        throw new Error(`${envVar} doit faire au moins 16 caractères`);
      // ALTER ROLE n'accepte pas de paramètre lié : on échappe le littéral.
      const { rows } = await client.query<{ q: string }>(
        'SELECT quote_literal($1) AS q',
        [password],
      );
      await client.query(`ALTER ROLE ${role} LOGIN PASSWORD ${rows[0].q}`);
      console.log(`- ${role} : mot de passe posé`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
