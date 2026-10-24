import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { hashBytes } from "../../domain/documents/render-input"
import { localDiskArtifactStore } from "../runtime"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function store() {
  const directory = await mkdtemp(join(tmpdir(), "quits-artifacts-"))
  directories.push(directory)
  return localDiskArtifactStore(directory)
}

const put = (artifacts: Awaited<ReturnType<typeof store>>, organizationId: string, documentId: string) => {
  const bytes = new TextEncoder().encode(`${organizationId}:${documentId}`)
  return artifacts.put(bytes, {
    organizationId, documentKind: "invoice", documentId, format: "pdf", hash: hashBytes(bytes), size: bytes.byteLength, rendererVersion: "v1",
  })
}

describe("local disk artifact store", () => {
  it("deletes one organization's files and leaves an organization whose id it prefixes", async () => {
    const artifacts = await store()
    const target = [await put(artifacts, "org-1", "a"), await put(artifacts, "org-1", "b")]
    const others = [await put(artifacts, "org-12", "a"), await put(artifacts, "org-1_x", "a"), await put(artifacts, "org", "a")]

    await artifacts.deleteOrganization!("org-1")

    for (const ref of target) await expect(artifacts.get(ref)).resolves.toBeNull()
    for (const ref of others) await expect(artifacts.head(ref)).resolves.not.toBeNull()
    // Sweeping again, or an organization that never stored a file, is a no-op.
    await expect(artifacts.deleteOrganization!("org-1")).resolves.toBeUndefined()
    await expect(artifacts.deleteOrganization!("org-none")).resolves.toBeUndefined()
  })

  it("refuses an organization id that is not a single path segment", async () => {
    const artifacts = await store()
    const kept = await put(artifacts, "org-1", "a")
    for (const id of ["", ".", "..", "../org-1", "org-1/invoice", "org-1/.."]) {
      await expect(artifacts.deleteOrganization!(id), id).rejects.toThrow("Invalid artifact identity")
    }
    await expect(artifacts.head(kept)).resolves.not.toBeNull()
  })
})
