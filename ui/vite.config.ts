import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_CONTROL_PROXY_TARGET || 'http://127.0.0.1:9999'

  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        '^/sim-state': { target, changeOrigin: true },
        '^/resources': { target, changeOrigin: true },
        '^/layout': { target, changeOrigin: true },
        '^/sync': { target, changeOrigin: true },
        '^/chirpstack': { target, changeOrigin: true },
        '^/topology': { target, changeOrigin: true },
        '^/config-profiles': { target, changeOrigin: true },
        '^/start': { target, changeOrigin: true },
        '^/stop': { target, changeOrigin: true },
        '^/status': { target, changeOrigin: true },
        '^/reset': { target, changeOrigin: true },
      },
    },
  }
})
