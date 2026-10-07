import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import tsconfigPaths from "vite-tsconfig-paths"

import { tanstackStart } from "@tanstack/react-start/plugin/vite"

import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { nitro } from "nitro/vite"
import { discoverWorkspaceEnvDir } from "../../scripts/workspace-env.js"
import { resolveDevtoolsEventBusPort } from "./src/build/devtools-port"

const appDir = fileURLToPath(new URL(".", import.meta.url))
const workspaceEnvDir = discoverWorkspaceEnvDir({ cwd: appDir }) ?? resolve(appDir, "../..")
const devtoolsEventBusPort = resolveDevtoolsEventBusPort({
  configuredPort: process.env.QUITS_DEVTOOLS_EVENT_BUS_PORT ?? process.env.YAIP_DEVTOOLS_EVENT_BUS_PORT,
  projectRoot: appDir,
})

const config = defineConfig({
  envDir: workspaceEnvDir,
  plugins: [
    devtools({
      eventBusConfig: {
        port: devtoolsEventBusPort,
      },
    }),
    nitro({ rollupConfig: { external: [/^@sentry\//] } }),
    tsconfigPaths({ projects: ['./tsconfig.json'] }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
