# Sentinel-X — Workshop 2026 M1

Partie développement du projet Sentinel-X (API + dashboard de supervision).

## Structure

```
backend/   API NestJS (préfixe /api/v1) : voir backend/README.md
frontend/  Dashboard React + Vite + TypeScript : voir frontend/README.md
firmware/  Firmware de l'ESP8266 (PlatformIO) : voir firmware/README.md
vision/    Reconnaissance faciale Python (YOLO + YuNet + SFace), toujours hors Docker
forecast/  Service de prévision Python (anomalies d'environnement, plus proche voisin)
infra/     Configuration et certificats TLS du broker Mosquitto du docker-compose.yml
docs/      GUIDELINES.md (référence technique) et schema-bdd.puml (modèle de données)
```

## Deux façons de lancer

| | [Tout en conteneurs](#a-tout-en-conteneurs-docker) | [En local](#b-en-local-développement) |
|---|---|---|
| Pour | Démo, serveur, tester l'ensemble | Développer le backend ou le dashboard (rechargement à chaud) |
| Fichier compose | `docker-compose.yml` | `docker-compose.dev.yml` (base et broker seulement) |
| En conteneur | Base, broker, API, dashboard, prévision, faux boîtier | Base et broker |
| Lancé à la main | `vision.py` | API, dashboard, prévision, faux boîtier, `vision.py` |
| Configuration | `.env` à la racine | `backend/.env`, `forecast/.env`, `vision/.env` |
| Prérequis | Docker | Docker, Node.js 22 ou plus, Python 3.11 |

Les deux piles sont indépendantes (bases et volumes séparés) et peuvent tourner en même temps : leurs ports ne se croisent pas.

### Ports

| Service | Conteneurs | Local |
|---|---|---|
| Dashboard | `http://localhost:6080` | `http://localhost:5173` |
| API | `http://localhost:6080/api/v1` (relayée par nginx, le port 3000 n'est pas publié) | `http://localhost:3000/api/v1` |
| Swagger | `http://localhost:6080/api/docs` | `http://localhost:3000/api/docs` |
| Broker MQTT | `6083` (MQTTS) | `1883` (en clair) |
| Base PostgreSQL | `6032` (depuis le serveur seulement) | `5432` (depuis la machine seulement) |
| `vision.py` | `5001` | `5001` |
| Flux vidéo | `http://localhost:6080/video/stream` | `http://localhost:5173/video/stream` |

Depuis une autre machine, remplacer `localhost` par l'IP du serveur. Les ports publiés par Docker se changent avec `SX_HTTP_PORT`, `SX_MQTT_PORT` et `SX_DB_PORT`.

## A. Tout en conteneurs (Docker)

```bash
cp .env.example .env     # une seule fois, puis remplir les secrets
# une seule fois : server.key et ca.crt dans infra/mosquitto/certs/ (voir son README)
docker compose up -d --build
```

Dashboard sur `http://<IP du serveur>:6080`, compte `ADMIN_USERNAME` / `ADMIN_PASSWORD` du `.env`.

La commande construit les images, crée la base (migrations, rôles, boîtiers, compte admin, jeu de référence IA) puis démarre l'API, le dashboard et le service de prévision. Les ports publiés sont tous entre 6000 et 6100 pour ne pas croiser ceux d'autres programmes.

Le broker n'accepte que MQTTS (TLS). Ses certificats sont dans [`infra/mosquitto/certs/`](infra/mosquitto/certs/README.md) : `server.key` et `ca.crt` ne sont pas commités et se copient à la main sur le serveur, comme le `.env`. Sans eux, la commande s'arrête.

Les secrets (mots de passe, secret JWT, clés d'API) ne sont dans aucun fichier commité : ils viennent du `.env` posé à côté du `docker-compose.yml`, ignoré par Git. Sans lui, la commande s'arrête en nommant la variable manquante. [`.env.example`](.env.example) donne la longueur minimale de chaque secret et une commande pour le générer (`openssl rand -hex 32`, ou `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` sans openssl). Sur un autre serveur, copier ce fichier à la main ou en créer un nouveau.

### Boîtier

- **Vrai ESP** : le broker écoute en MQTTS sur le port 6083 du serveur. Régler ce port et l'autorité `ca.crt` dans le firmware (`firmware/include/secrets.h`), ou mettre `SX_MQTT_PORT=8883` dans `.env`. Certificats, flash et vérifications pas à pas : [`firmware/README.md`](firmware/README.md).
- **Faux boîtier** (sans ESP sous la main) :

  ```bash
  docker compose --profile sim up -d --build
  ```

  Il ajoute un faux `SX-001`, branché comme le vrai (port 6083 du serveur, en TLS). Ne jamais le lancer en même temps que le vrai ESP. Pour le garder à chaque `up` : `COMPOSE_PROFILES=sim` dans `.env`.

  Il envoie un résumé de mesures toutes les 5 s, des détections (mouvement, IR) et, toutes les 5 min en moyenne, une anomalie d'environnement. Une anomalie ne passe que par les mesures : c'est le service de prévision qui la reconnaît et crée l'alerte. Pour en déclencher une à la main : `echo g | docker attach sentinel-x-fake-esp-1` (`g` fuite de gaz, `b` incendie, `p` pluie, `a` aimant ; `m` mouvement et `i` présence IR restent des événements du boîtier).

### Commandes utiles

| Besoin | Commande |
|---|---|
| État des conteneurs | `docker compose ps` |
| Journaux | `docker compose logs -f backend forecast` |
| Reconstruire après un changement de code | `docker compose up -d --build` |
| Rejouer migrations, rôles et seed | `docker compose run --rm setup` |
| Arrêt | `docker compose down` |
| Arrêt et base vide | `docker compose down -v` |

Faux boîtier lancé : arrêter avec `docker compose --profile sim down`, pour qu'il soit arrêté lui aussi (inutile si `COMPOSE_PROFILES=sim` est dans `.env`).

- **Vérifier la prévision** : `docker compose logs -f forecast` affiche une ligne par mesure reçue du boîtier, avec ce que le modèle en conclut (`SX-001 : 22.0 °C, 44.1 %, gaz 149, hall 1 -> Normal`). Une situation anormale est suivie de `Alerte envoyée`, et l'alerte « Anomalie détectée » (source `ml`) apparaît dans le dashboard. Aucune ligne alors que le boîtier émet : le service ne reçoit rien.
- **Vision** : `vision.py` reste hors Docker, voir [Module vision](#module-vision-reconnaissance-faciale).
- **Réglages** : ports et autres options se règlent dans `.env`, voir [`.env.example`](.env.example).
- **Limites** : le broker est en TLS mais sans authentification (pas encore de compte par client ni d'ACL), le dashboard en HTTP. HTTPS (443) reste à la brique INFRA. L'API tourne avec `NODE_ENV=production`, qui refuse un broker sans TLS.

## B. En local (développement)

Seuls la base et le broker sont en conteneurs ; le reste se lance à la main, un terminal par service. Les commandes partent de la racine du dépôt.

### 1. Base et broker

```bash
docker compose -f docker-compose.dev.yml up -d --wait
```

`--wait` rend la main quand les deux sont prêts. Base sur `localhost:5432` (compte propriétaire `sentinel` / `sentinel`), broker sur `localhost:1883`, en clair et sans authentification.

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env     # une seule fois, puis remplir
npm run db:setup         # migrations, rôles Postgres, boîtiers, compte admin, jeu de référence IA
npm run start:dev        # http://localhost:3000/api/v1
```

`backend/.env` est obligatoire : `npm run start:dev` refuse de démarrer sans lui. Les adresses de [`backend/.env.example`](backend/.env.example) sont déjà celles du dev local, il reste à remplir les secrets (détail dans [`backend/README.md`](backend/README.md)).

### 3. Dashboard

```bash
cd frontend
npm install
npm run dev              # http://localhost:5173
```

Connexion avec `ADMIN_USERNAME` / `ADMIN_PASSWORD` de `backend/.env`. Vite relaie `/api` vers le backend (`localhost:3000`) et `/video` vers `vision.py` (`localhost:5001`).

### 4. Faux boîtier (sans ESP)

```bash
cd backend
npm run sim:esp -- --auto --interval 5
```

Faux `SX-001` sur le broker de `MQTT_URL` (`backend/.env`). `--auto` ajoute des détections et des anomalies d'environnement aléatoires. Au clavier, une lettre puis Entrée : `m` mouvement, `i` présence IR, `g` fuite de gaz, `b` incendie, `p` pluie, `a` aimant, `q` quitter. Autres options en tête de [`backend/scripts/fake-esp.ts`](backend/scripts/fake-esp.ts).

### 5. Service de prévision (facultatif)

```bash
cd forecast
python -m venv venv
venv/Scripts/python -m pip install -r requirements.txt   # venv/bin/python sous Linux et macOS
cp .env.example .env                                      # une seule fois, puis remplir
venv/Scripts/python Code_ai_predict.py
```

Dans `forecast/.env` : le mot de passe de `DATABASE_URL` est `DB_IA_PASSWORD` de `backend/.env` (à poser avec `npm run db:roles` s'il a été ajouté après le `db:setup`), et `API_KEY` est la clé `anomaly` de `SERVICE_API_KEYS`. Le service affiche une ligne par mesure reçue, comme en conteneur.

Tests : `venv/Scripts/python -m pip install -r requirements-dev.txt` puis `venv/Scripts/python -m pytest tests`.

### Arrêt

`Ctrl+C` dans chaque terminal, puis :

```bash
docker compose -f docker-compose.dev.yml down     # ajouter -v pour repartir d'une base vide
```

Après un `down -v`, relancer `npm run db:setup`.

### Port déjà pris

Si le port 5432 ou 1883 est occupé sur la machine, changer celui que Docker publie, puis reporter le port dans `DATABASE_URL`, `DB_ADMIN_URL` et `MQTT_URL` (`backend/.env`), `DATABASE_URL` (`forecast/.env`) et `DB_PORT` (`vision/.env`) :

```bash
SX_DB_PORT=5433 SX_MQTT_PORT=1884 docker compose -f docker-compose.dev.yml up -d --wait
```

Sous PowerShell : `$env:SX_DB_PORT=5433; $env:SX_MQTT_PORT=1884` avant la commande. Ne pas mettre ces deux variables dans le `.env` racine si les deux piles servent sur la même machine : il est lu par les deux fichiers compose, qui publieraient alors les mêmes ports.

## Module vision (reconnaissance faciale)

`vision.py` lit la webcam du boîtier, reconnaît les visages à partir des tables `persons` et `face_embeddings`, envoie ses alertes au backend et sert le flux annoté au dashboard. Il tourne toujours hors Docker, pour garder un accès direct à la webcam, sur la machine qui héberge le reste.

```bash
cd vision
python -m venv venv
venv/Scripts/python -m pip install -r requirements.txt   # venv/bin/python sous Linux et macOS
cp .env.example .env                                      # une seule fois, puis remplir
venv/Scripts/python vision.py                             # ou : vision.py --video test.mp4
```

Ce qui change dans `vision/.env` selon le mode :

| `vision/.env` | Avec les conteneurs | En local |
|---|---|---|
| `API_URL` | `http://localhost:6080/api/v1/alerts` | `http://localhost:3000/api/v1/alerts` |
| `API_KEY` | `VISION_API_KEY` du `.env` racine | clé `vision` de `SERVICE_API_KEYS` (`backend/.env`) |
| `DB_PORT` | `6032` | `5432` |
| `DB_USER` | `sentinel_vision` | `sentinel_vision` |
| `DB_PASSWORD` | `DB_VISION_PASSWORD` du `.env` racine | `DB_VISION_PASSWORD` de `backend/.env`, puis `npm run db:roles` |
| `VISION_PORT` | `5001` | `5001` |

Dans l'autre sens, le backend et le dashboard joignent `vision.py` sur le port 5001 :

- **Avec les conteneurs** : rien à régler, `VISION_URL` et `VISION_UPSTREAM` valent `http://host.docker.internal:5001` par défaut. Si le serveur a un pare-feu, il doit laisser les conteneurs Docker joindre le port 5001.
- **En local** : `VISION_URL=http://localhost:5001` dans `backend/.env` ; le proxy `/video` de Vite pointe déjà sur ce port.

`vision.py` arrêté, le dashboard affiche « Flux vidéo indisponible » et le reste fonctionne.

- **Enregistrer une personne** : page Personnes du dashboard (rôle admin). La personne se place devant la caméra du boîtier, le backend relaie la demande à `vision.py`.
- **Sans webcam** : `venv/Scripts/python add_person.py "Nom" photo.jpg --consent` enregistre à partir de photos (compte propriétaire de la base, `ADMIN_DB_USER` et `ADMIN_DB_PASSWORD` dans `vision/.env`).
- **Tests** : `venv/Scripts/python -m pip install -r requirements-dev.txt` puis `venv/Scripts/python -m pytest tests`.
