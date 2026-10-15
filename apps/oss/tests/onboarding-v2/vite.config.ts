import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  // Only crawl this harness's pages. screenshots.html imports QUI-56 baseline
  // aliases that exist only in screenshots.vite.config.ts; scanning it fails the
  // dep pre-scan, so Vite optimizes on first request and reloads mid-test.
  optimizeDeps: { entries: ["index.html", "away.html"] },
  server: {
    host: "127.0.0.1",
    port: 4316,
    fs: { allow: [new URL("../../../..", import.meta.url).pathname] },
  },
})
