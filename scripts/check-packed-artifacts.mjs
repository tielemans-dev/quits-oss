import { execFileSync, execFile } from "node:child_process"
import { mkdtempSync, readdirSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from "node:fs"
import { createServer } from "node:http"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
const root = fileURLToPath(new URL("../", import.meta.url))
const directory = mkdtempSync(join(tmpdir(), "quits-artifact-package-"))
const run = promisify(execFile)
let registry
try {
  const archives = {}
  for (const [name, path] of [["oss", "apps/oss"], ["contracts", "packages/contracts"], ["shared", "packages/shared"]]) {
    const destination = join(directory, name)
    mkdirSync(destination)
    execFileSync("bun", ["pm", "pack", "--destination", destination], { cwd: resolve(root, path), stdio: "pipe" })
    archives[name] = join(destination, readdirSync(destination).find(name => name.endsWith(".tgz")))
  }
  const unpack = join(directory, "unpack")
  mkdirSync(unpack)
  execFileSync("tar", ["-xzf", archives.oss, "-C", unpack])
  process.stdout.write(execFileSync(process.execPath, [resolve(root, "scripts/check-artifact-boundaries.mjs"), join(unpack, "package/src")], { encoding: "utf8" }))
  // Serve unpublished versions from their exact tarballs, with no dependency overrides.
  const packages = Object.values(archives).map(archive => ({
    archive,
    manifest: JSON.parse(execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" })),
  }))
  registry = createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url, "http://localhost").pathname.slice(1))
    const packed = packages.find(({ manifest }) => name === manifest.name || name === `${manifest.name}.tgz`)
    if (!packed) { response.writeHead(404); response.end(); return }
    const tarball = readFileSync(packed.archive)
    if (name.endsWith(".tgz")) { response.end(tarball); return }
    const { manifest } = packed
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ name: manifest.name, "dist-tags": { latest: manifest.version }, versions: {
      [manifest.version]: { ...manifest, dist: { tarball: `http://127.0.0.1:${registry.address().port}/${manifest.name}.tgz`,
        integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}` } },
    } }))
  })
  await new Promise(resolve => registry.listen(0, "127.0.0.1", resolve))
  const consumer = join(directory, "consumer")
  mkdirSync(consumer)
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "quits-artifact-consumer", private: true, type: "module", dependencies: {
    ...Object.fromEntries(packages.map(({ manifest }) => [manifest.name, manifest.version])),
    "typescript": "^5.7.2", "tsx": "^4.20.0", "vite": "^7.1.7", "@types/node": "^22.10.2", "@types/react": "^19.2.0", "@types/react-dom": "^19.2.0",
    "@types/pg": "^8.16.0", "@types/markdown-it": "^14.2.0", "@types/sanitize-html": "^2.16.2",
  } }))
  writeFileSync(join(consumer, ".npmrc"), `@quits:registry=http://127.0.0.1:${registry.address().port}\n`)
  await run("npx", ["--yes", "pnpm@10.28.2", "install", "--ignore-scripts"], { cwd: consumer, maxBuffer: 10 * 1024 * 1024 })
  writeFileSync(join(consumer, "consumer.ts"), `
import assert from "node:assert/strict"
import { createRequire } from "node:module"
const app = createRequire(import.meta.resolve("@quits/oss/runtime/auth-config"))
const { betterAuth } = await import(app.resolve("better-auth"))
import { buildQuitsAuthOptions } from "@quits/oss/runtime/auth-config"
import { bootstrapQuitsRuntime } from "@quits/oss/runtime"
import { getRuntimeCapabilities } from "@quits/oss/runtime/extensions"
import { getDocumentRenderer, getDocumentArtifactStore, getManagedAiProvider, type DocumentRenderer, type DocumentArtifactStore } from "@quits/oss/runtime/services"
import { AiProviderError, type AiProvider } from "@quits/oss/ai/provider"
const renderer: DocumentRenderer = { version: "consumer-v1", renderPdf: async input => new TextEncoder().encode(input.number) }
const store: DocumentArtifactStore = { put: async (_bytes, meta) => meta.hash, get: async () => null, head: async () => null, delete: async () => {} }
// A distribution's managed AI provider reports failures as AiProviderError so they are sanitised.
const managedAi: AiProvider = {
  id: "managed",
  defaultModel: "consumer/model",
  complete: async () => { throw new AiProviderError({ code: "http", providerId: "managed", message: "upstream detail" }) },
}
bootstrapQuitsRuntime({ services: { documentRenderer: renderer, documentArtifactStore: store, managedAiProvider: managedAi } })
assert.equal(getManagedAiProvider(), managedAi)
await assert.rejects(managedAi.complete({ model: "m", messages: [] }), (error: unknown) => error instanceof AiProviderError && error.code === "http")
const optional: boolean = getRuntimeCapabilities().documents.artifactsRequired
assert.equal(optional, true)
assert.equal(getDocumentRenderer(), renderer)
assert.equal(getDocumentArtifactStore(), store)
const options = buildQuitsAuthOptions({ prisma: { $executeRaw: async () => 0 } as never, env: { getEnv: name => name === "BETTER_AUTH_URL" ? "http://localhost:3000" : undefined } })
const auth = betterAuth({ ...options, secret: "packed-consumer-secret-over-thirty-two-characters" })
assert.equal(typeof auth.handler, "function")
assert.equal(typeof auth.api.requestPasswordReset, "function")
assert.equal(typeof auth.api.resetPassword, "function")
const response = await auth.handler(new Request("http://localhost:3000/api/auth/ok"))
assert.equal(response.status, 200)
assert.deepEqual(await response.json(), { ok: true })
`)
  writeFileSync(join(consumer, "exports.ts"), packages.flatMap(({ manifest }) =>
    Object.keys(manifest.exports).filter(key => !key.endsWith(".css")).map(key =>
      `import "${manifest.name}${key === "." ? "" : key.slice(1)}"`
    )
  ).join("\n"))
  // The source package uses the app alias; resolve it inside the installed tarball only.
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", paths: { "#/*": ["./node_modules/@quits/oss/src/*"] }, noEmit: true, strict: true, skipLibCheck: true, esModuleInterop: true, types: ["node", "vite/client"] }, include: ["consumer.ts", "exports.ts"] }))
  const entry = realpathSync(join(consumer, "node_modules/@quits/oss/package.json"))
  // Resolve from the installed app, as pnpm does not hoist its runtime dependencies.
  writeFileSync(join(consumer, "versions.mjs"), `
import { createRequire } from "node:module"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
const app = createRequire(${JSON.stringify(entry)})
const manifest = app("./package.json")
for (const name of ["better-auth", "@better-auth/core"]) {
  assert.equal(manifest.dependencies[name], "1.5.4")
  let directory = dirname(app.resolve(name))
  while (!existsSync(join(directory, "package.json"))) directory = dirname(directory)
  const version = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version
  assert.equal(version, "1.5.4")
  console.log(name + " resolved to " + version)
}
const auth = createRequire(app.resolve("better-auth"))
assert.equal(auth.resolve("@better-auth/core/context"), app.resolve("@better-auth/core/context"))
`)
  process.stdout.write(execFileSync(process.execPath, ["versions.mjs"], { cwd: consumer, encoding: "utf8" }))
  execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], { cwd: consumer, stdio: "pipe" })
  execFileSync(process.execPath, ["--import", "tsx", "consumer.ts"], { cwd: consumer, stdio: "pipe" })
  console.log("Packed Node/pnpm consumer types and runtime configuration passed without overrides")
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  if (registry) await new Promise(resolve => registry.close(resolve))
  rmSync(directory, { recursive: true, force: true })
}
