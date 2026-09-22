import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The repository also contains two standalone Betaflight applications.
  // Restrict the app dev-server scan to the root entry so Vite does not try to
  // resolve their independent Vue dependency trees from this package.
  optimizeDeps: {
    entries: ["index.html"],
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
      },
      "/uploads": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
      },
      "/live-ws": {
        target: "http://127.0.0.1:3000",
        ws: true,
      },
    },
  },
})
