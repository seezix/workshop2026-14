FROM node:20-alpine
WORKDIR /app
# On copie d'abord uniquement les fichiers de dépendances
COPY package*.json ./
RUN npm install
# Le reste du code sera monté via le volume dans le docker-compose
EXPOSE 3000
CMD ["npm", "run", "start:dev"]