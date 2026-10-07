import { beforeEach } from "vitest"
import { setRuntimeServices, getDocumentRenderer, getDocumentArtifactStore } from "../lib/runtime/services"
import type { ArtifactMeta } from "../lib/runtime/services"

/** Synthetic adapters for integration tests; no filesystem or provider writes. */
beforeEach(() => {
  const objects = new Map<string, { bytes: Uint8Array; meta: ArtifactMeta }>()
  setRuntimeServices({
    ...(!getDocumentRenderer() ? { documentRenderer: { version: "synthetic-test-v1", async renderPdf(input) { return new TextEncoder().encode(JSON.stringify(input)) } } } : {}),
    ...(!getDocumentArtifactStore() ? { documentArtifactStore: {
      async put(bytes: Uint8Array, meta: ArtifactMeta) { const ref = `${meta.organizationId}/${meta.documentId}/${meta.hash}`; objects.set(ref, { bytes, meta }); return ref },
      async get(ref: string) { return objects.get(ref)?.bytes ?? null },
      async head(ref: string) { return objects.get(ref)?.meta ?? null },
      async delete(ref: string) { objects.delete(ref) },
    } } : {}),
  })
})
