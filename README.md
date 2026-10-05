# Sentinel-X — Workshop 2026 M1

Partie développement du projet Sentinel-X (API + dashboard de supervision).

## Structure

```
backend/   API NestJS (port 3000, préfixe /api/v1)
frontend/  Dashboard React + Vite + TypeScript (port 5173)
```

## Lancer en local

```bash
# Backend
cd backend
npm install
npm run start:dev      # http://localhost:3000/api/v1

# Frontend
cd frontend
npm install
npm run dev            # http://localhost:5173
```

En développement, Vite redirige `/api` vers le backend (`localhost:3000`).
