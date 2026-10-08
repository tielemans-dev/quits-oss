import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises"
import { resolve, dirname, relative, isAbsolute } from "node:path"
import { randomUUID } from "node:crypto"
import { hashBytes } from "../domain/documents/hash"
import type { ArtifactMeta, DocumentArtifactStore } from "../lib/runtime/services"

const absent = (error: unknown) => (error as { code?: string }).code === "ENOENT"
/** Content-addressed immutable bytes. Ref paths cannot escape the configured root. */
export function localDiskArtifactStore(root: string): DocumentArtifactStore {
  const directory = resolve(root)
  function path(ref: string) {
    const result = resolve(directory, ref)
    const rel = relative(directory, result)
    if (!ref || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Invalid artifact ref")
    return result
  }
  async function read(ref: string) {
    try { return new Uint8Array(await readFile(path(ref))) }
    catch (error) { if (absent(error)) return null; throw error }
  }
  async function atomicWrite(destination: string, bytes: Uint8Array | string) {
    await mkdir(dirname(destination), { recursive: true })
    const temporary = `${destination}.${randomUUID()}.tmp`
    try { await writeFile(temporary, bytes); await rename(temporary, destination) }
    finally { await unlink(temporary).catch(error => { if (!absent(error)) throw error }) }
  }
  return {
    async put(bytes, meta) {
      if (hashBytes(bytes) !== meta.hash || bytes.byteLength !== meta.size) throw new Error("Artifact metadata does not match bytes")
      const segment = (value: string) => {
        if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Invalid artifact identity")
        return value
      }
      const ref = `${segment(meta.organizationId)}/${segment(meta.documentKind)}/${segment(meta.documentId)}/${meta.hash}.${meta.format === "pdf" ? "pdf" : "xml"}`
      await atomicWrite(path(ref), bytes)
      await atomicWrite(path(`${ref}.meta.json`), JSON.stringify(meta))
      return ref
    },
    get: read,
    async head(ref) {
      const bytes = await read(ref)
      if (!bytes) return null
      const metadata = await read(`${ref}.meta.json`)
      if (!metadata) return null
      const meta = JSON.parse(new TextDecoder().decode(metadata)) as ArtifactMeta
      if (meta.hash !== hashBytes(bytes) || meta.size !== bytes.byteLength) throw new Error("Corrupt artifact")
      return meta
    },
    async delete(ref) {
      for (const name of [ref, `${ref}.meta.json`]) {
        await unlink(path(name)).catch(error => { if (!absent(error)) throw error })
      }
    },
  }
}
