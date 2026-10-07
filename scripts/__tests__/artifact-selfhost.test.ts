import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// Run the host adapter with Bun. Core tests never import this host-only module.
describe("self-host artifact adapters", () => {
  it("renders deterministic server PDFs and atomically stores verified bytes in the configured directory", () => {
    const adapter = fileURLToPath(new URL("../../apps/oss/src/selfhost/runtime.ts", import.meta.url))
    const program = `
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { createHash } from "node:crypto"
import assert from "node:assert/strict"
const { selfhostRuntimeServices } = await import(${JSON.stringify(adapter)})
const dir = await mkdtemp(join(tmpdir(), "quits-artifact-adapter-"))
try {
  const { documentRenderer: renderer, documentArtifactStore: store } = selfhostRuntimeServices({ YAIP_ARTIFACT_DIR: dir })
  const input = { kind: "invoice", organizationId: "org", documentId: "invoice", number: "INV-0001",
    issuedAt: "2026-10-07T10:00:00.000Z", recipient: "customer@example.test", snapshot: {}, pdf: {
      invoice: { number: "INV-0001", status: "sent", issueDate: "2026-10-07T10:00:00.000Z", dueDate: "2026-12-01",
        subtotal: 100, taxAmount: 0, total: 100, currency: "USD", notes: null,
        contact: { name: "Customer" }, items: [{ description: "Work", quantity: 1, unitPrice: 100, total: 100 }] },
      org: { companyName: "Synthetic seller", locale: "en-US", timezone: "UTC" },
    } }
  const a = await renderer.renderPdf(input)
  const b = await renderer.renderPdf(input)
  assert.equal(new TextDecoder().decode(a.slice(0, 5)), "%PDF-")
  assert.deepEqual(a, b)
  const hash = createHash("sha256").update(a).digest("hex")
  const metadata = { organizationId: "org", documentKind: "invoice", documentId: "invoice", format: "pdf", hash,
    size: a.byteLength, rendererVersion: renderer.version }
  const [ref, second] = await Promise.all([store.put(a, metadata), store.put(a, metadata)])
  assert.equal(ref, second)
  assert.equal(ref, "org/invoice/invoice/" + hash + ".pdf")
  assert.deepEqual(await store.get(ref), a)
  assert.deepEqual(await store.head(ref), metadata)
  assert.deepEqual(new Uint8Array(await readFile(join(dir, ref))), a)
  assert.equal((await readdir(dirname(join(dir, ref)))).length, 2)
  await assert.rejects(store.put(a, { ...metadata, hash: "0".repeat(64) }))
  await assert.rejects(store.get("../../outside.pdf"))
  await store.delete(ref)
  await store.delete(ref)
  assert.equal(await store.get(ref), null)
  assert.equal(await store.head(ref), null)
  console.log("Bun renderer and local store passed")
} finally { await rm(dir, { recursive: true, force: true }) }
`
    expect(execFileSync("bun", ["--eval", program], { encoding: "utf8", timeout: 30_000 })).toContain("Bun renderer and local store passed")
  }, 35_000)
})
