# Sentinel-X · Dashboard

Dashboard de supervision du boîtier `SX-001`, construit d'après le wireframe
« Sentinel-X · Dashboard (wireframe) v0.1 » et le contrat d'API de `docs/GUIDELINES.md`.

React 19 + Vite + TypeScript, Tailwind CSS 4, React Router, Apache ECharts.

## Lancer

```bash
npm install
npm run dev        # http://localhost:5173
```

Le serveur Vite redirige `/api` vers le backend (`localhost:3000`) et `/video`
vers vision.py (`localhost:8080`, flux MJPEG). En production, nginx sert le
build (`npm run build` → `dist/`) et fait les mêmes redirections.

Variable optionnelle : `VITE_DEVICE_ID` (par défaut `SX-001`).

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
