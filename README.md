# Sentinel-X — Workshop 2026 M1

Partie développement du projet Sentinel-X (API + dashboard de supervision).

## Structure

```
backend/   API NestJS (port 3000, préfixe /api/v1) : voir backend/README.md
frontend/  Dashboard React + Vite + TypeScript (port 5173)
vision/    Reconnaissance faciale Python (YOLO + YuNet + SFace, port 5001)
forecast/  Service de prévision Python (anomalies d'environnement, plus proche voisin)
infra/     Configuration du broker Mosquitto du docker-compose.yml
docs/      GUIDELINES.md (référence technique) et schema-bdd.puml (modèle de données)
```

## Tout lancer avec Docker

```bash
cp .env.example .env     # une seule fois, puis remplir les secrets
docker compose up -d --build
```

Les secrets (mots de passe, secret JWT, clés d'API) ne sont dans aucun fichier commité : ils viennent du `.env` posé à côté du `docker-compose.yml`, ignoré par Git. Sans lui, la commande s'arrête en nommant la variable manquante. Sur un autre serveur, copier ce fichier à la main ou en créer un nouveau.

Dashboard sur `http://<IP du serveur>:6080`, compte `ADMIN_USERNAME` / `ADMIN_PASSWORD` du `.env`. La commande construit les images, crée la base (migrations, rôles, boîtiers, compte admin, jeu de référence IA) puis démarre l'API, le dashboard et le service de prévision. Le broker écoute sur le port 6083 pour l'ESP (à régler dans le firmware, ou `SX_MQTT_PORT=1883` dans `.env`). Les ports publiés sont tous entre 6000 et 6100 pour ne pas croiser ceux d'autres programmes.

Sans ESP sous la main, `docker compose --profile sim up -d --build` ajoute un faux boîtier `SX-001`, branché comme le vrai (port 6083 du serveur). Ne jamais le lancer en même temps que le vrai ESP.

- **Réglages** : ports et autres options se règlent aussi dans `.env`, voir [`.env.example`](.env.example).
- **Faux boîtier** : il envoie un résumé de mesures toutes les 5 s, des détections (mouvement, IR) et, toutes les 5 min en moyenne, une anomalie d'environnement. Une anomalie ne passe que par les mesures : c'est le service de prévision qui la reconnaît et crée l'alerte. Pour en déclencher une à la main : `echo g | docker attach sentinel-x-fake-esp-1` (`g` fuite de gaz, `b` incendie, `p` pluie, `a` aimant ; `m` mouvement et `i` présence IR restent des événements du boîtier).
- **Vérifier la prévision** : `docker compose logs -f forecast` affiche une ligne par mesure reçue du boîtier, avec ce que le modèle en conclut (`SX-001 : 22.0 °C, 44.1 %, gaz 149, hall 1 -> Normal`). Une situation anormale est suivie de `Alerte envoyée`, et l'alerte « Anomalie détectée » (source `ml`) apparaît dans le dashboard. Aucune ligne alors que le boîtier émet : le service ne reçoit rien.
- **Vision** : `vision.py` reste hors Docker, pour garder un accès direct à la webcam. Il se lance sur le serveur comme décrit plus bas ; la pile le joint sur le port 5001 du serveur, et lui joint l'API (`http://localhost:6080`) et la base (`localhost:6032`). Dans `vision/.env` : `API_URL=http://localhost:6080/api/v1/alerts`, `API_KEY` = `VISION_API_KEY`, `DB_PORT=6032`, `DB_USER=sentinel_vision`, `DB_PASSWORD` = `DB_VISION_PASSWORD`. Si le serveur a un pare-feu, il doit laisser les conteneurs Docker joindre le port 5001.
- **État et journaux** : `docker compose ps`, `docker compose logs -f backend forecast`.
- **Arrêt** : `docker compose down` (ajouter `-v` pour repartir d'une base vide).
- **Limites** : le broker est en clair et sans authentification, le dashboard en HTTP. TLS (8883 et 443) reste à la brique INFRA ; l'API tourne donc avec `NODE_ENV=development`, le mode production refusant un broker sans TLS.

## Lancer en local (développement)

```bash
# Base TimescaleDB et broker de dev
docker compose -f docker-compose.dev.yml up -d --wait

# Backend (variables d'environnement : voir backend/README.md)
cd backend
npm install
npm run db:setup
npm run start:dev      # http://localhost:3000/api/v1

# Frontend
cd frontend
npm install
npm run dev            # http://localhost:5173
```

En développement, Vite redirige `/api` vers le backend (`localhost:3000`).

## Module vision (reconnaissance faciale)

`vision.py` lit la webcam du boîtier, reconnaît les visages à partir des tables `persons` et `face_embeddings`, envoie ses alertes au backend et sert le flux annoté au dashboard.

```bash
cd vision
python -m venv venv
venv/Scripts/python -m pip install -r requirements.txt   # venv/bin/python sous Linux et macOS
cp .env.example .env                                      # puis remplir
venv/Scripts/python vision.py                             # ou : vision.py --video test.mp4
```

Trois valeurs relient les `.env` :

| `backend/.env` | `vision/.env` |
|---|---|
| `SERVICE_API_KEYS=vision=<clé>` | `API_KEY=<clé>` |
| `DB_VISION_PASSWORD=<mot de passe>` puis `npm run db:roles` | `DB_USER=sentinel_vision`, `DB_PASSWORD=<mot de passe>` |
| `VISION_URL=http://localhost:5001` | `VISION_PORT=5001` |

- **Enregistrer une personne** : page Personnes du dashboard (rôle admin). La personne se place devant la caméra du boîtier, le backend relaie la demande à `vision.py`.
- **Sans webcam** : `venv/Scripts/python add_person.py "Nom" photo.jpg --consent` enregistre à partir de photos (compte propriétaire de la base, `ADMIN_DB_USER`).
- **Tests** : `venv/Scripts/python -m pip install -r requirements-dev.txt` puis `venv/Scripts/python -m pytest tests`.
