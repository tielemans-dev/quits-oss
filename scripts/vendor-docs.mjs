// Import byte-for-byte public upstream documentation, or verify it offline.
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"

const root = new URL("../", import.meta.url)
const directory = new URL("docs/vendor/", root)
const { sources } = JSON.parse(await readFile(new URL("docs/vendor-sources.json", root), "utf8"))
const mode = process.argv.slice(2)
if (mode.length !== 1 || !["--check", "--fetch"].includes(mode[0])) {
  throw new Error("Usage: node scripts/vendor-docs.mjs --check|--fetch")
}

const snapshots = []
let total = 0
for (const source of sources) {
  if (!/^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/.test(source.repository)
    || !/^[a-f0-9]{40}$/.test(source.revision)) {
    throw new Error(`Invalid pinned repository: ${source.name}`)
  }
  const prefix = `${source.repository.replace("github.com", "raw.githubusercontent.com")}/${source.revision}/`
  for (const file of source.files) {
    if (!file.url.startsWith(prefix) || !/^[\w.-]+\/[\w.-]+$/.test(file.path)
      || file.path.split("/").some(part => part === "." || part === "..")) {
      throw new Error(`Invalid snapshot path or URL: ${file.path}`)
    }
    const target = new URL(file.path, directory)
    let bytes
    if (mode[0] === "--fetch") {
      const response = await fetch(file.url, { signal: AbortSignal.timeout(30_000), redirect: "error" })
      if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`)
      bytes = Buffer.from(await response.arrayBuffer())
    } else {
      bytes = await readFile(target)
    }
    total += bytes.length
    if (total > 128 * 1024) throw new Error("Vendored docs exceed the 128 KiB budget")
    if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new Error(`Snapshot checksum mismatch: ${file.path}`)
    }
    snapshots.push({ target, bytes })
  }
}
// Verify every download before replacing any local snapshot.
if (mode[0] === "--fetch") {
  for (const { target, bytes } of snapshots) {
    await mkdir(new URL(".", target), { recursive: true })
    await writeFile(target, bytes)
  }
}
console.log(`vendor-docs: ${snapshots.length} snapshots verified, ${total} bytes`)
