import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

test("motion guard rejects variants of catch-all transitions and timing literals", () => {
  const root = mkdtempSync(join(tmpdir(), "motion-guard-"))
  try {
    mkdirSync(join(root, "scripts")); mkdirSync(join(root, "apps"))
    writeFileSync(join(root, "scripts/check-motion.mjs"), readFileSync(new URL("../check-motion.mjs", import.meta.url)))
    execFileSync("git", ["init", "-q", root])
    const file = join(root, "apps/example.tsx")
    writeFileSync(file, "")
    execFileSync("git", ["add", "apps"], { cwd: root })
    for (const value of ["hover:transition-all", "duration-200", "duration-[90ms]", "ease-out", "transition: all 1s", "transition: opacity 200ms var(--ease-enter)", "animation: fade 0.3s", "el.animate(k, { duration: 300 })", 'el.animate(k, { easing: "ease-out" })']) {
      writeFileSync(file, `className="${value}"`)
      assert.equal(spawnSync(process.execPath, ["scripts/check-motion.mjs"], { cwd: root }).status, 1)
    }
    writeFileSync(file, 'className="transition-opacity duration-(--duration-fade) ease-enter"\nel.animate(k, { duration: DURATION.fade, easing: EASE_ENTER })\nanimation: fade var(--duration-base) var(--ease-enter); animation-delay: 0ms')
    assert.equal(spawnSync(process.execPath, ["scripts/check-motion.mjs"], { cwd: root }).status, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
