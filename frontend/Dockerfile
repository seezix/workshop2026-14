FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
EXPOSE 5173
# N'oubliez pas le --host 0.0.0.0 pour que Vite soit accessible depuis l'extérieur du conteneur
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]