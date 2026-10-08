import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const script = fileURLToPath(new URL("../check-artifact-boundaries.mjs", import.meta.url))

describe("artifact import boundaries", () => {
  it("keeps selfhost and filesystem rendering outside the published graph, with no issuance cycle", () => {
    expect(execFileSync(process.execPath, [script], { encoding: "utf8" })).toContain("Artifact boundaries passed")
  })

  function check(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "artifact-boundaries-"))
    try {
      for (const [name, content] of Object.entries(files)) {
        mkdirSync(join(root, name, ".."), { recursive: true })
        writeFileSync(join(root, name), content)
      }
      return () => execFileSync(process.execPath, [script, root], { encoding: "utf8", stdio: "pipe" })
    } finally {
      // The script reads files synchronously when invoked, so keep them until then.
      process.on("exit", () => rmSync(root, { recursive: true, force: true }))
    }
  }

  it("lets selfhost modules share code with each other", () => {
    expect(check({ "selfhost/a.ts": 'import { b } from "./b"\nexport const a = b', "selfhost/b.ts": "export const b = 1" })()).toContain("passed")
  })

  it("still refuses any module outside selfhost that imports it", () => {
    expect(check({ "lib/x.ts": 'import { a } from "../selfhost/a"\nexport const x = a', "selfhost/a.ts": "export const a = 1" })).toThrow(/lib\/x\.ts imports selfhost/)
  })
})
