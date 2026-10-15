import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { documentColors } from "../document-colors"

const generator = fileURLToPath(new URL("../../../../../../scripts/generate-document-colors.mjs", import.meta.url))

describe("documentColors", () => {
  it("matches every light-theme document token, including aliases, alpha colors and badge tints", () => {
    const expected = JSON.parse(execFileSync(process.execPath, [generator, "--json"], { encoding: "utf8" }))
    expect(documentColors).toEqual(expected)
  })
})
