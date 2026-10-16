import assert from "node:assert/strict"
import { get } from "node:http"
import { test } from "node:test"
import { Worker } from "node:worker_threads"

const runner = new URL("./runtime/internal/vite/node-runner.mjs", import.meta.resolve("nitro/vite"))

function request(address, accept) {
  return new Promise((resolve, reject) => {
    const req = get({
      ...address,
      path: "/",
      headers: { accept },
    }, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => { body += chunk })
      response.on("end", () => resolve({ status: response.statusCode, body }))
      response.on("error", reject)
    })
    // Playwright has no per-request timeout. Fail here if Nitro leaves the GET hanging.
    req.setTimeout(6000, () => req.destroy(new Error("Nitro readiness GET never completed")))
    req.on("error", reject)
  })
}

test("a slow Nitro environment returns 503 to readiness probes, then recovers", { timeout: 15000 }, async (t) => {
  // Exercise the installed worker and HTTP adapter, including Bun's dependency patch.
  const worker = new Worker(runner, { workerData: { server: true }, stdout: true, stderr: true })
  t.after(() => worker.terminate())
  const listening = Promise.withResolvers()
  const importing = Promise.withResolvers()
  worker.on("error", (error) => {
    listening.reject(error)
    importing.reject(error)
  })
  worker.on("message", (message) => {
    if (message.event === "listen") listening.resolve(message.address)
    if (message.event === "vite:invoke") importing.resolve(message)
  })
  const address = await listening.promise
  worker.postMessage({
    type: "custom",
    event: "nitro:vite-env",
    data: {
      name: "nitro",
      entry: "data:text/javascript,export const fetch = () => new Response('ready')",
    },
  })
  // Hold the real module runner's first RPC until both early requests have completed.
  // This deterministically exceeds EnvRunner.fetch's 3.1-second initialization grace period.
  const pending = await importing.promise
  assert.equal(pending.data.name, "getBuiltins")
  const [html, json] = await Promise.all([
    request(address, "*/*"), // Playwright's readiness Accept header.
    request(address, "application/json"),
  ])
  assert.equal(html.status, 503)
  assert.match(html.body, /Vite environment.*nitro.*is unavailable/)
  assert.equal(json.status, 503)
  assert.equal(JSON.parse(json.body).message, 'Vite environment "nitro" is unavailable')

  worker.postMessage({
    type: "custom",
    event: "vite:invoke",
    viteEnv: "nitro",
    data: { id: pending.data.id.replace("send:", "response:"), data: { result: [] } },
  })
  const ready = await request(address, "*/*")
  assert.equal(ready.status, 200)
  assert.equal(ready.body, "ready")
})
