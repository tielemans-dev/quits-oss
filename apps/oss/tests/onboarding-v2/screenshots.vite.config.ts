import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { resolve } from "node:path"

const baseline = process.env.QUI56_BASELINE_DIR
if (!baseline) throw new Error("Set QUI56_BASELINE_DIR to a detached origin/main checkout")
const mocks = resolve(import.meta.dirname, "screenshots-mocks.tsx")
export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    {
      name: "screenshot-transports",
      enforce: "pre",
      resolveId(source) {
        if (source.endsWith("lib/i18n/react"))
          return resolve(import.meta.dirname, "../../src/lib/i18n/react.tsx")
        if (
          source === "@tanstack/react-router" ||
          /(?:lib\/(?:auth-client|runtime-distribution)|trpc\/client)$/.test(source)
        )
          return mocks
        if (source === "qui56-baseline-onboarding")
          return resolve(baseline, "apps/oss/src/routes/_app/onboarding.tsx")
        if (source === "qui56-baseline-welcome")
          return resolve(baseline, "apps/oss/src/components/dashboard/welcome.tsx")
      },
    },
    react(),
    tailwindcss(),
  ],
  server: {
    host: "127.0.0.1",
    port: 4317,
    fs: { allow: [resolve(import.meta.dirname, "../../../.."), baseline] },
  },
})
