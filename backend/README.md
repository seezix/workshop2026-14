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

## Lancer

Deux modes, décrits pas à pas dans le [README racine](../README.md) :

| | En conteneur | En local |
|---|---|---|
| Commande | `docker compose up -d --build` à la racine | `npm run start:dev` dans `backend/` |
| API | `http://localhost:6080/api/v1` (relayée par nginx, le port 3000 n'est pas publié) | `http://localhost:3000/api/v1` |
| Configuration | `.env` à la racine | `backend/.env` |
| Base, broker | Services `db` et `mosquitto` du `docker-compose.yml` | `docker-compose.dev.yml` (`localhost:5432`, `localhost:1883`) |
| Migrations et seed | Service `setup`, rejoué à chaque `up` | `npm run db:setup` |

### En local

```bash
cd backend

# Base TimescaleDB et broker de dev (le broker de prod est en TLS sur 8883).
# --wait rend la main quand les deux sont prêts ; les données restent dans un volume.
docker compose -f ../docker-compose.dev.yml up -d --wait

npm install
cp .env.example .env     # une seule fois, puis remplir (voir ci-dessous)

# Schéma, rôles Postgres, boîtiers SX-001 / SX-SIM, compte admin, jeu de référence IA
npm run db:setup

npm run start:dev        # http://localhost:3000/api/v1
```

`backend/.env` est obligatoire : `start:dev` le charge (`--env-file .env`) et s'arrête s'il manque. Les adresses de [`.env.example`](.env.example) sont celles du dev local ; à remplir avant le premier `db:setup` :

| Variable | Valeur |
|---|---|
| `DB_APP_PASSWORD` | 16 caractères min., à recopier dans `DATABASE_URL` |
| `ADMIN_PASSWORD` | 12 caractères min. : mot de passe du compte `admin` du dashboard |
| `JWT_SECRET` | 32 caractères min. |
| `SERVICE_API_KEYS` | Une clé de 24 caractères min. par service : `vision=<clé>,anomaly=<clé>` |
| `DB_IA_PASSWORD`, `DB_VISION_PASSWORD` | 16 caractères min., seulement pour lancer le service de prévision ou `vision.py` |

Les mots de passe finissent dans des URL : ni `@`, ni `:`, ni `/`. Pour en générer : `openssl rand -hex 16` (ou `-hex 32` pour une valeur de 64 caractères) ; sans openssl, `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`.

La config est validée au démarrage : une variable manquante ou invalide empêche le lancement, avec son nom dans le message. Un mot de passe de rôle changé après coup se repose avec `npm run db:roles`. Une variable déjà définie dans le terminal l'emporte sur celle du `.env`.

Arrêt : `docker compose -f ../docker-compose.dev.yml down` (ajouter `-v` pour repartir d'une base vide, puis relancer `npm run db:setup`). Si le port 5432 ou 1883 est déjà pris, définir `SX_DB_PORT` / `SX_MQTT_PORT` avant le `up` et reporter le port dans `DATABASE_URL`, `DB_ADMIN_URL` et `MQTT_URL`.

### En conteneur

Rien à faire dans ce dossier : `docker compose up -d --build` à la racine construit l'image ([`Dockerfile`](Dockerfile)), lance le service `setup` (`npm run db:setup` avec le compte propriétaire) puis l'API. Les variables viennent du `.env` racine, `backend/.env` n'est pas lu.

| Besoin | Commande (à la racine) |
|---|---|
| Journaux de l'API | `docker compose logs -f backend` |
| Reconstruire après un changement de code | `docker compose up -d --build backend` |
| Rejouer migrations, rôles et seed | `docker compose run --rm setup` |
| Vérifier que l'API répond | `curl http://localhost:6080/api/v1/health` |

## Documentation de l'API

Swagger UI : http://localhost:3000/api/docs en local, http://localhost:6080/api/docs en conteneur (document OpenAPI brut : `/api/docs-json`). Les corps, paramètres et droits d'accès affichés sont tirés des schémas zod des `ZodPipe` et des décorateurs `@Access` (`src/common/openapi.ts`) : rien à maintenir à la main, hormis le résumé `@ApiOperation` de chaque route. Les réponses ne sont pas décrites. Désactivé quand `NODE_ENV=production`, sauf `SWAGGER_ENABLED=true`.

## Scripts

| Commande | Rôle |
|---|---|
| `npm run start:dev` | API en mode watch (lit `.env`) |
| `npm run build` / `start:prod` | Compilation / exécution de `dist/` |
| `npm test` | Tests unitaires (vitest) |
| `npm run test:e2e` | Tests de bout en bout, sautés si `E2E_DATABASE_URL` n'est pas défini |
| `npm run lint` / `typecheck` / `format` | oxlint, tsc, prettier |
| `npm run db:migrate` | Applique `db/migrations/*.sql` (compte propriétaire, `DB_ADMIN_URL`) |
| `npm run db:roles` | Pose les mots de passe de `sentinel_app`, `sentinel_ia`, `sentinel_vision` depuis le `.env` |
| `npm run db:seed` | Boîtiers `SX-001` et `SX-SIM`, premier compte admin, jeu de référence du modèle IA |
| `npm run db:setup` | Les trois à la suite |
| `npm run sim:esp` | Faux boîtier MQTT pour travailler sans matériel, sur le broker de `MQTT_URL` (`-- --auto` pour des détections et des anomalies d'environnement aléatoires, voir `scripts/fake-esp.ts`). En conteneur : `docker compose --profile sim up -d` |

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
- **`POST /persons/enroll`** : relayé à `VISION_URL/enroll` avec la clé du service `vision` en `X-Api-Key` (vision.py fait la capture et écrit la personne). `503` si `VISION_URL` ou la clé `vision` de `SERVICE_API_KEYS` manque. La réponse arrive à la fin de la capture (20 s au plus).
- Code d'erreur ajouté au contrat : `503 SERVICE_UNAVAILABLE`.

## Reste à faire

- `docker-compose.yml` à la racine : il lance tout le projet (voir le README racine), avec un broker en MQTTS (TLS) mais sans authentification, et un dashboard en HTTP. Restent à la brique INFRA : un compte par client et l'ACL sur le broker, HTTPS (443).
- `tools/fake-esp` pour générer l'historique de `SX-SIM`.
