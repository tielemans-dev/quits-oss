import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

describe("artifact import boundaries", () => {
  it("keeps selfhost and filesystem rendering outside the published graph, with no issuance cycle", () => {
    const script = fileURLToPath(new URL("../check-artifact-boundaries.mjs", import.meta.url))
    expect(execFileSync(process.execPath, [script], { encoding: "utf8" })).toContain("Artifact boundaries passed")
  })
})
