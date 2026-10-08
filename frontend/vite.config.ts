import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // Docker : nom du service backend dans docker-compose.yml
      '/api': 'http://backend:3000',
      // Flux MJPEG de vision.py (VISION_PORT de vision/.env ; servi par nginx en production).
      '/video': 'http://localhost:5001',
    },
  },
})
