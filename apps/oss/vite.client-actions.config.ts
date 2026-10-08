import { appendFileSync } from "node:fs"
import { defineConfig, type PluginOption } from "vite"
import base from "./vite.config"

const mailbox = process.env.CLIENT_ACTIONS_MAILBOX
if (!mailbox) throw new Error("Supply a synthetic client action mailbox file")

/** Capture synthetic email on the app's existing listener, without a second test-server port. */
export default defineConfig({
  ...base,
  // This test environment removes every @tanstack/devtools:* plugin, including source
  // instrumentation and the event-bus listener. Product Vite configuration is unchanged.
  plugins: [
    (base.plugins ?? []).flat().filter((plugin) => !(plugin && typeof plugin === "object" && "name" in plugin && plugin.name.startsWith("@tanstack/devtools:"))) as PluginOption[],
    {
      name: "client-actions-synthetic-email",
      configureServer(server) {
        server.middlewares.use("/__client-actions-email", async (request, response) => {
          if (request.method !== "POST") { response.writeHead(405).end(); return }
          let body = ""
          for await (const chunk of request) body += chunk
          appendFileSync(mailbox, `${JSON.stringify(JSON.parse(body))}\n`)
          response.writeHead(200, { "content-type": "application/json" })
          response.end(JSON.stringify({ id: "synthetic-client-email" }))
        })
      },
    },
  ],
})
