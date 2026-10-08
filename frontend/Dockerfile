# Sentinel-X dashboard : build Vite puis nginx (statique + relais /api et /video)
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Même npm que le lockfile (voir backend/Dockerfile)
RUN npm install -g npm@11.11.0 && npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
# Remplacés par envsubst au démarrage du conteneur (voir nginx.conf.template)
ENV BACKEND_UPSTREAM=http://backend:3000 \
    VISION_UPSTREAM=http://vision:5001
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
