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
  // Vite finds the auth client's core modules only after the first page has loaded, re-bundles
  // them and reloads the page. On a cold dev server that reload can land in the middle of a
  // sign-in, which made the first browser smoke test in CI fail. Bundling them up front avoids it.
  // If the dev log shows "new dependencies optimized" for other modules, add them here.
  optimizeDeps: {
    include: [
      "@better-auth/core",
      "@better-auth/core/api",
      "@better-auth/core/db",
      "@better-auth/core/db/adapter",
      "@better-auth/core/env",
      "@better-auth/core/error",
      "@better-auth/core/oauth2",
      "@better-auth/core/social-providers",
      "@better-auth/core/utils/db",
      "@better-auth/core/utils/deprecate",
      "@better-auth/core/utils/error-codes",
      "@better-auth/core/utils/id",
      "@better-auth/core/utils/ip",
      "@better-auth/core/utils/json",
      "@better-auth/core/utils/string",
      "@better-auth/core/utils/url",
    ],
  },
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
