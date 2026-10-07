# Sentinel-X : backend

API NestJS + TypeScript. Seul composant qui écrit les données métier et qui parle à l'ESP (via Mosquitto).
Référence : [`docs/GUIDELINES.md`](../docs/GUIDELINES.md) et [`docs/schema-bdd.puml`](../docs/schema-bdd.puml).

```
ESP ──MQTT──▶ Mosquitto ──▶ IngestService ──▶ PostgreSQL + TimescaleDB
                  ▲                │
                  └── cmd / config ┤  AlertsService ──▶ RulesService (intrusion → buzzer + LED)
                                   └─▶ RealtimeService ──SSE──▶ dashboard
vision.py / service IA ── POST /alerts (X-Api-Key) ──┘
```

## Démarrage en local

```bash
cd backend
npm install

# Base TimescaleDB et broker de dev (le broker de prod est en TLS sur 8883)
docker run -d --name sx-db -e POSTGRES_USER=sentinel -e POSTGRES_PASSWORD=sentinel \
  -e POSTGRES_DB=sentinel -p 5432:5432 timescale/timescaledb:latest-pg16
docker run -d --name sx-mq -p 1883:1883 eclipse-mosquitto:2 \
  sh -c 'printf "listener 1883\nallow_anonymous true\n" > /m.conf && mosquitto -c /m.conf'

# Schéma, rôles Postgres, boîtiers SX-001 / SX-SIM et compte admin
export DB_ADMIN_URL=postgres://sentinel:sentinel@localhost:5432/sentinel
DB_APP_PASSWORD=dev-app-password-123 ADMIN_USERNAME=admin ADMIN_PASSWORD=admin-password-123 \
  npm run db:setup

# API
export DATABASE_URL=postgres://sentinel_app:dev-app-password-123@localhost:5432/sentinel
export JWT_SECRET=$(openssl rand -base64 48) COOKIE_SECURE=false MQTT_URL=mqtt://localhost:1883
export SERVICE_API_KEYS=vision=$(openssl rand -hex 24)
npm run start:dev        # http://localhost:3000/api/v1
```

Toutes les variables sont décrites dans [`.env.example`](.env.example). La config est validée au démarrage : une variable manquante ou invalide empêche le lancement.

## Documentation de l'API

Swagger UI : http://localhost:3000/api/docs (document OpenAPI brut : `/api/docs-json`). Les corps, paramètres et droits d'accès affichés sont tirés des schémas zod des `ZodPipe` et des décorateurs `@Access` (`src/common/openapi.ts`) : rien à maintenir à la main, hormis le résumé `@ApiOperation` de chaque route. Les réponses ne sont pas décrites. Désactivé quand `NODE_ENV=production`, sauf `SWAGGER_ENABLED=true`.

## Scripts

| Commande | Rôle |
|---|---|
| `npm run start:dev` | API en mode watch |
| `npm run build` / `start:prod` | Compilation / exécution de `dist/` |
| `npm test` | Tests unitaires (vitest) |
| `npm run test:e2e` | Tests de bout en bout, sautés si `E2E_DATABASE_URL` n'est pas défini |
| `npm run lint` / `typecheck` / `format` | oxlint, tsc, prettier |
| `npm run db:migrate` | Applique `db/migrations/*.sql` (compte propriétaire, `DB_ADMIN_URL`) |
| `npm run db:roles` | Pose les mots de passe de `sentinel_app`, `sentinel_ia`, `sentinel_vision` depuis le `.env` |
| `npm run db:seed` | Boîtiers `SX-001` et `SX-SIM`, premier compte admin, jeu de référence du modèle IA |
| `npm run db:setup` | Les trois à la suite |
| `npm run sim:esp` | Faux boîtier MQTT pour travailler sans matériel (`-- --auto` pour des détections aléatoires, voir `scripts/fake-esp.ts`) |

## Base de données

- Source de vérité : le SQL de `db/migrations/` (tables, hypertables, agrégats `telemetry_1h` / `telemetry_1d`, compression 7 j, rétention 365 j, rôles). `src/db/schema.ts` en est le miroir Drizzle pour les requêtes typées.
- Les migrations ne sont pas transactionnelles (TimescaleDB refuse de créer un agrégat continu dans une transaction) : une instruction par bloc `--> statement-breakpoint`.
- Le backend se connecte avec `sentinel_app`, jamais avec le compte propriétaire.
- Le service d'anomalies écrit directement dans `anomaly_scores` ; un trigger `NOTIFY anomaly_score` permet au backend de pousser `anomaly.score` en SSE.
- `model_reference_data` : jeu de référence du modèle IA de prévision (345 600 mesures étiquetées, une toutes les 2 s). `npm run db:seed` le charge depuis `db/seeds/model_reference_data.csv.gz` si la table est vide ; `sentinel_ia` y a accès en lecture seule. Pour le recharger : `TRUNCATE model_reference_data;` puis `npm run db:seed`.
- Après l'insertion de l'historique simulé : `CALL refresh_continuous_aggregate('telemetry_1h', NULL, NULL);` (idem `_1d`).

## Organisation du code

| Dossier | Contenu |
|---|---|
| `config/` | Variables d'environnement validées par zod |
| `db/` | Pool Postgres, client Drizzle, schéma |
| `common/` | Format d'erreur unique, validation zod, limite de débit |
| `auth/` | Login JWT (Bearer + cookie httpOnly), garde globale rôles / `X-Api-Key` |
| `mqtt/` | Connexion au broker, ingestion (telemetry, events, status, cmd/ack), datation des messages ESP |
| `devices/` | Routes `/devices/*` : état, config (publiée en retained), historique, stats, export, commandes |
| `alerts/` | `POST /alerts` (point d'entrée unique, dédoublonnage 10 s, désarmement), filtres, acquittement |
| `commands/` | Parcours d'une commande : `pending` → publication QoS 1 → `done` / `rejected` / `timeout` (5 s) |
| `rules/` | Décisions du backend : `INTRUSION_CONFIRMED` (PIR + vision < 5 s) → buzzer + LED rouge si armé |
| `persons/` | Reconnaissance faciale (sans empreintes), effacement en cascade, purge des inconnus après 72 h |
| `realtime/` | Bus interne et flux `GET /stream` (SSE) |
| `audit/` | Journal `audit_log` (connexions, échecs, actions sensibles) |

## Contrat : choix faits dans cette version

- **Accès** : sans décorateur, une route demande un JWT `viewer`. `@Access({ role, services })` ouvre aux rôles supérieurs et/ou aux services (`X-Api-Key`, clé déclarée dans `SERVICE_API_KEYS`).
- **`POST /alerts` boîtier désarmé** : les détections de présence (`MOTION_DETECTED`, `IR_DETECTED`, `PERSON_*`, `INTRUSION_CONFIRMED`) renvoient `200 { alert: null, suppressed: true }`. Gaz, sabotage, pannes, anomalies et hors ligne créent toujours une alerte.
- **Doublon** : même `device_id` + `source` + `type`, non résolue, vue dans les 10 dernières secondes. La sévérité retenue est la plus haute.
- **Commandes** : refusées (`409 DEVICE_OFFLINE`) vers un boîtier hors ligne ou simulé ; `503 SERVICE_UNAVAILABLE` si le broker est injoignable. Un ack arrivé après le timeout est quand même enregistré.
- **Boîtier inconnu sur MQTT** : message ignoré (il faut d'abord ajouter une ligne dans `devices`).
- **Datation** : à la réception ; les événements du tampon hors ligne sont recalés grâce à `uptime_ms` (voir `mqtt/device-clock.ts`).
- **`POST /persons/enroll`** : relayé à `VISION_URL/enroll` (vision.py fait la capture et écrit la personne), `503` si non configuré.
- Code d'erreur ajouté au contrat : `503 SERVICE_UNAVAILABLE`.

## Reste à faire

- `docker-compose.yml` à la racine (brique INFRA) : services `db`, `mosquitto`, `backend`, `nginx`, avec `npm run db:setup` au premier lancement.
- `tools/fake-esp` pour générer l'historique de `SX-SIM`.
- Le Dockerfile n'a pas pu être construit dans l'environnement de développement de cette PR (pas d'accès réseau pour `npm ci`) : à vérifier sur une machine de l'équipe.
