import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import type { ArtifactMeta } from "../../lib/runtime/services"
import { artifactGap, inventoryArtifacts, referenceProblems } from "./artifacts"
import { readFile, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import { ARTIFACT_DIRECTORY, MANIFEST_FILE, parseManifest, RecoveryError, type Manifest } from "../../lib/recovery/format"

export type Finding = {
  severity: "error" | "warning"
  code: string
  message: string
  /** What the operator can do about it. */
  action?: string
}

export const sha256Bytes = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")

export function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256")
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolvePromise(hash.digest("hex")))
  })
}

/** Resolves `file` inside `directory`, refusing anything that escapes it. */
export function insideBundle(directory: string, file: string) {
  const root = resolve(directory)
  const result = resolve(root, file)
  const rel = relative(root, result)
  if (!file || rel.startsWith("..") || isAbsolute(rel)) {
    throw new RecoveryError("unsafe_path", `The manifest names a path outside the bundle: ${file}.`, "The bundle is damaged or was tampered with; do not restore it.")
  }
  return result
}

export type BundleCheck = {
  manifest: Manifest
  /** SHA-256 of manifest.json; record it somewhere other than the bundle to detect replacement. */
  manifestSha256: string
  findings: Finding[]
  filesChecked: number
  bytesChecked: number
}

/**
 * Checks a bundle against its own manifest without touching any database: every listed file must
 * exist with the recorded size and SHA-256, and every artifact must match its recorded hash.
 * Detects corruption, truncation and missing objects. It cannot detect a bundle whose manifest
 * was rewritten along with its files; compare `manifestSha256` with a copy kept elsewhere for that.
 */
export async function verifyBundle(directory: string): Promise<BundleCheck> {
  let text: string
  try {
    text = await readFile(join(directory, MANIFEST_FILE), "utf8")
  } catch {
    throw new RecoveryError("manifest_missing", `No ${MANIFEST_FILE} in ${directory}.`, "Point at the bundle directory that `backup create` wrote.")
  }
  const manifest = parseManifest(text)
  const findings: Finding[] = []
  let filesChecked = 0
  let bytesChecked = 0

  const check = async (file: string, sha256: string, bytes: number, label: string) => {
    let path: string
    try {
      path = insideBundle(directory, file)
    } catch (error) {
      findings.push({ severity: "error", code: "unsafe_path", message: (error as Error).message })
      return
    }
    let size: number
    try {
      size = (await stat(path)).size
    } catch {
      findings.push({
        severity: "error",
        code: label === "artifact" ? "artifact_object_missing" : "bundle_file_missing",
        message: `${label === "artifact" ? "Artifact" : "File"} ${file} is listed in the manifest but missing from the bundle.`,
        action: "The bundle is incomplete; use another copy or take a new backup.",
      })
      return
    }
    filesChecked += 1
    bytesChecked += size
    if (size !== bytes) {
      findings.push({ severity: "error", code: "size_mismatch", message: `${file} is ${size} bytes; the manifest recorded ${bytes}.`, action: "The file was truncated or changed; use another copy." })
      return
    }
    if ((await sha256File(path)) !== sha256) {
      findings.push({ severity: "error", code: "integrity_mismatch", message: `${file} does not match its recorded SHA-256.`, action: "The file is corrupt or was changed; use another copy." })
    }
  }

  for (const table of manifest.database.tables) await check(table.file, table.sha256, table.bytes, "database")
  const databaseIntact = !findings.some(finding => finding.severity === "error")
  const metadata = new Map<string, ArtifactMeta>()
  const objects = new Map<string, Manifest["artifacts"]["objects"][number]>()
  for (const object of manifest.artifacts.objects) {
    if (objects.has(object.ref)) findings.push({ severity: "error", code: "artifact_duplicate_reference",
      message: `The manifest lists ${object.ref} more than once.`, action: "Use another copy or take a new backup; an object must have one inventory entry." })
    objects.set(object.ref, object)
    await check(object.file, object.sha256, object.bytes, "artifact")
    try {
      const meta = JSON.parse(await readFile(insideBundle(directory, object.metaFile), "utf8")) as ArtifactMeta
      metadata.set(object.ref, meta)
      if (meta.hash !== object.sha256 || meta.size !== object.bytes) {
        findings.push({ severity: "error", code: "artifact_meta_mismatch", message: `${object.metaFile} disagrees with the manifest about ${object.ref}.`, action: "Use another copy of the bundle." })
      }
    } catch {
      findings.push({ severity: "error", code: "artifact_meta_missing", message: `${object.metaFile} is missing or unreadable.`, action: "Use another copy of the bundle." })
    }
  }
  const gaps = [...manifest.artifacts.missing]
  if (databaseIntact) {
    try {
      const inventory = await inventoryArtifacts(async (name, columns) => {
        const table = manifest.database.tables.find(table => table.name === name)
        if (!table) return [] // Older schemas need not contain all of today's tables.
        const rows: Record<string, unknown>[] = []
        const lines = createInterface({ input: createReadStream(insideBundle(directory, table.file), "utf8"), crlfDelay: Infinity })
        for await (const line of lines) {
          if (!line) continue
          const row = JSON.parse(line) as Record<string, unknown>
          rows.push(Object.fromEntries(columns.map(column => [column, row[column]])))
        }
        return rows
      }, new Date(manifest.createdAt))
      gaps.push(...inventory.missing)
      for (const reference of inventory.references) {
        const object = objects.get(reference.ref)
        if (!object) { gaps.push(artifactGap(reference, "object_not_bundled")); continue }
        const meta = metadata.get(reference.ref)
        if (meta) for (const problem of referenceProblems(reference, meta, object.sha256, object.bytes)) gaps.push(artifactGap(reference, problem))
      }
    } catch {
      findings.push({ severity: "error", code: "artifact_inventory_unreadable", message: "Artifact requirements could not be read from the bundled database rows.",
        action: "Use another copy or take a new backup; do not enable operations from an unverified inventory." })
    }
  }
  const uniqueGaps = new Map(gaps.map(gap => [JSON.stringify(gap), gap]))
  for (const problem of uniqueGaps.values()) {
    const hard = problem.problem !== "no_reference"
    findings.push({
      severity: hard ? "error" : "warning",
      code: `backup_${problem.problem}`,
      message: `${problem.table} ${problem.id}: ${problem.field} ${problemText(problem.problem)}${problem.ref ? ` (${problem.ref})` : ""}. This bundle does not satisfy the recorded artifact requirement.`,
      action: hard ? "Restore the missing object into the source artifact directory and take a new backup." : "Documents issued before artifacts were recorded have none; this is expected for legacy data.",
    })
  }
  return {
    manifest,
    manifestSha256: sha256Bytes(text),
    findings,
    filesChecked,
    bytesChecked,
  }
}

function problemText(problem: string) {
  switch (problem) {
    case "object_not_bundled": return "references an object omitted from the bundle inventory"
    case "required_reference_missing": return "has no PDF reference for retained issuance work"
    case "staging_candidate_disagreement": return "disagrees with the linked staging artifacts"
    case "no_reference": return "has no stored artifact"
    case "object_missing": return "points at an object that was not in the artifact store"
    case "hash_mismatch": return "points at an object whose bytes do not match the recorded hash"
    case "hash_not_recorded": return "has no recorded hash to verify against"
    default: return problem
  }
}

export { ARTIFACT_DIRECTORY }
