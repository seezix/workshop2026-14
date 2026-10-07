# Sentinel-X — Workshop 2026 M1

Partie développement du projet Sentinel-X (API + dashboard de supervision).

## Structure

```
backend/   API NestJS (port 3000, préfixe /api/v1) : voir backend/README.md
frontend/  Dashboard React + Vite + TypeScript (port 5173)
docs/      GUIDELINES.md (référence technique) et schema-bdd.puml (modèle de données)
```

## Lancer en local

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
