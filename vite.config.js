import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/5AM/' : '/',
  plugins: [react()],
  server: {
    allowedHosts: ['c03f-39-49-172-36.ngrok-free.app'],
  },
}))
