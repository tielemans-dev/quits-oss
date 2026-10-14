import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 4316,
    fs: { allow: [new URL("../../../..", import.meta.url).pathname] },
  },
})
