import { execFileSync } from "node:child_process"
import { mkdtempSync, readdirSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
const root = fileURLToPath(new URL("../", import.meta.url))
const directory = mkdtempSync(join(tmpdir(), "quits-artifact-package-"))
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
  // Consume the exact packed dependencies. No link, sibling source or workspace substitution.
  const consumer = join(directory, "consumer")
  mkdirSync(consumer)
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "quits-artifact-consumer", private: true, type: "module", dependencies: {
    "@quits/oss": archives.oss, "@quits/contracts": archives.contracts, "@quits/shared": archives.shared,
    "typescript": "^5.7.2", "@types/node": "^22.10.2", "@types/react": "^19.2.0", "@types/react-dom": "^19.2.0",
    "@types/pg": "^8.16.0", "@types/markdown-it": "^14.2.0", "@types/sanitize-html": "^2.16.2",
  }, overrides: { "@quits/contracts": archives.contracts, "@quits/shared": archives.shared } }))
  execFileSync("bun", ["install", "--ignore-scripts"], { cwd: consumer, stdio: "pipe" })
  writeFileSync(join(consumer, "consumer.ts"), `
import { bootstrapQuitsRuntime } from "@quits/oss/runtime"
import { getRuntimeCapabilities } from "@quits/oss/runtime/extensions"
import type { DocumentRenderer, DocumentArtifactStore } from "@quits/oss/runtime/services"
const renderer: DocumentRenderer = { version: "consumer-v1", renderPdf: async input => new TextEncoder().encode(input.number) }
const store: DocumentArtifactStore = { put: async (_bytes, meta) => meta.hash, get: async () => null, head: async () => null, delete: async () => {} }
bootstrapQuitsRuntime({ services: { documentRenderer: renderer, documentArtifactStore: store } })
const optional: boolean = getRuntimeCapabilities().documents.artifactsRequired
console.log(optional)
`)
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", noEmit: true, strict: true, skipLibCheck: true, esModuleInterop: true, types: ["node", "vite/client"] }, include: ["consumer.ts"] }))
  execFileSync("bun", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], { cwd: consumer, stdio: "pipe" })
  console.log("Packed artifact consumer typecheck passed with exact tarballs and optional capability")
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  rmSync(directory, { recursive: true, force: true })
}
