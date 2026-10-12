import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

const stub = fileURLToPath(new URL('./synthetic-runtime.tsx', import.meta.url))
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tailwind()],
  resolve: { alias: [
    { find: '@tanstack/react-router', replacement: stub },
    { find: /.*auth-client$/, replacement: stub },
    { find: /.*runtime-distribution$/, replacement: stub },
    { find: /.*signup-config$/, replacement: stub },
  ] },
  server: { fs: { allow: [fileURLToPath(new URL('../../../../../', import.meta.url))] } },
})
