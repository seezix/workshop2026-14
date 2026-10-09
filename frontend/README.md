# Sentinel-X · Dashboard

Dashboard de supervision du boîtier `SX-001`, construit d'après le wireframe
« Sentinel-X · Dashboard (wireframe) v0.1 » et le contrat d'API de `docs/GUIDELINES.md`.

React 19 + Vite + TypeScript, Tailwind CSS 4, React Router, Apache ECharts.

## Lancer

Deux modes, décrits pas à pas dans le [README racine](../README.md) :

| | En conteneur | En local |
|---|---|---|
| Commande | `docker compose up -d --build` à la racine | `npm run dev` dans `frontend/` |
| Dashboard | `http://localhost:6080` | `http://localhost:5173` |
| Servi par | nginx, à partir du build (`dist/`) | Vite, avec rechargement à chaud |
| `/api` relayé vers | Conteneur `backend` (port 3000 interne) | `localhost:3000` |
| `/video` relayé vers | `vision.py` sur le serveur (`host.docker.internal:5001`) | `localhost:5001` |

### En local

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

Il faut le backend lancé sur `localhost:3000` (voir [`backend/README.md`](../backend/README.md)) ;
connexion avec `ADMIN_USERNAME` / `ADMIN_PASSWORD` de `backend/.env`. Les
redirections `/api` et `/video` (flux MJPEG de vision.py) sont dans
[`vite.config.ts`](vite.config.ts). Sans vision.py, la vue d'ensemble affiche
« Flux vidéo indisponible » et le reste fonctionne.

### En conteneur

Rien à faire dans ce dossier : `docker compose up -d --build` à la racine
construit le dashboard (`npm run build` → `dist/`) et le sert avec nginx sur le
port 6080 (`SX_HTTP_PORT` du `.env` racine). Les redirections sont dans
[`nginx.conf.template`](nginx.conf.template) ; l'adresse de vision.py se change
avec `VISION_UPSTREAM`. Après un changement de code :
`docker compose up -d --build frontend`.

Variable optionnelle : `VITE_DEVICE_ID` (par défaut `SX-001`), à mettre dans
`frontend/.env` en local. L'image Docker ne lit pas ce fichier et garde `SX-001`.

## Écrans

| Route | Écran | API utilisée |
|---|---|---|
| `/` | Vue d'ensemble temps réel | `GET /devices/{id}`, `/telemetry`, `/anomaly-scores`, `/events`, `/commands`, `/alerts` · `POST /commands` · `PATCH /alerts/{id}` |
| `/alertes` | Liste filtrable + détail, acquitter / résoudre | `GET /alerts` · `PATCH /alerts/{id}` |
| `/historique` | Tuiles de stats, courbes, détections, heatmap, export CSV | `GET /devices`, `/telemetry`, `/stats`, `/anomaly-scores`, `/events?type=GAS_RISE`, `/telemetry/export` |
| `/personnes` | Reconnaissance faciale (opérateur), actions admin | `GET /persons`, `/persons/{id}/sightings` · `PATCH`/`DELETE /persons/{id}` · `POST /persons/enroll` |
| `/boitier` | État, santé, config armé / intervalle, commandes | `GET /health` · `PUT /devices/{id}/config` · `POST`/`GET /commands` |

## Temps réel

Une seule connexion SSE (`GET /api/v1/stream`) partagée par toute l'application
(`src/live/stream.ts`). Les écrans s'abonnent avec `useStreamEvent(type, handler)`.
`src/live/LiveProvider.tsx` garde l'état commun : boîtier, dernier résumé,
dernier score IA, alertes ouvertes, alertes sonores.

## Authentification

`POST /auth/login` pose le cookie httpOnly `sx_token`, utilisé pour le REST
comme pour le SSE. Le jeton n'est jamais lu ni stocké en JavaScript ; seuls le
profil et l'échéance de session sont gardés dans `localStorage`. Un `401`
renvoie à l'écran de connexion. Les actions sont masquées ou désactivées selon
le rôle (`viewer`, `operator`, `admin`), le backend restant seul juge.
