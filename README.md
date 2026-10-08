# Sentinel-X — Workshop 2026 M1

Partie développement du projet Sentinel-X (API + dashboard de supervision).

## Structure

```
backend/   API NestJS (port 3000, préfixe /api/v1) : voir backend/README.md
frontend/  Dashboard React + Vite + TypeScript (port 5173)
vision/    Reconnaissance faciale Python (YOLO + YuNet + SFace, port 5001)
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
