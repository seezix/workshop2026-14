import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // Juste http://backend:3000 sans rien après !
      '/api': 'http://backend:3000',
      // Flux MJPEG de vision.py (servi par nginx en production).
      '/video': 'http://localhost:8080',
    },
  },
})