#!/bin/bash

echo "Création du Dockerfile pour le Backend (NestJS)..."
cat << 'EOF' > backend/Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "run", "start:dev"]
EOF

echo "Création du Dockerfile pour le Frontend (React/Vite)..."
cat << 'EOF' > frontend/Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host"]
EOF

echo "Création du docker-compose.yml à la racine..."
cat << 'EOF' > docker-compose.yml
services:
  db:
    image: postgres:15-alpine
    restart: always
    environment:
      POSTGRES_USER: root
      POSTGRES_PASSWORD: password
      POSTGRES_DB: nest_db
    volumes:
      - db_data:/var/lib/postgresql/data
    networks:
      - app_network

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    ports:
      - "3001:3000" # Modifié pour éviter le conflit avec l'autre projet
    volumes:
      - ./backend:/app
      - /app/node_modules
    environment:
      - DATABASE_URL=postgresql://root:password@db:5432/nest_db
    depends_on:
      - db
    networks:
      - app_network

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    ports:
      - "5173:5173"
    volumes:
      - ./frontend:/app
      - /app/node_modules
    environment:
      - VITE_API_URL=http://localhost:3001/api/v1 # Modifié pour cibler le bon port
    depends_on:
      - backend
    networks:
      - app_network

volumes:
  db_data:

networks:
  app_network:
    driver: bridge
EOF

echo "Terminé ! Les fichiers de configuration Docker ont été créés avec le port 3001."