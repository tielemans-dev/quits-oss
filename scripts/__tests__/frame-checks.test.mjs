import assert from "node:assert/strict"
import { test } from "node:test"
import { frameChecker } from "../record-motion-checks.mjs"

const clean = Uint8Array.from({ length: 64 * 36 }, (_, i) => i % 256)
const changed = clean.map((n) => 255 - n)
test("clean and gradual frames pass; blank, pop-in, flicker and layout shift identify samples", () => {
  const checker = frameChecker(240)
  for (let i = 0; i < 30; i++) checker.add(clean.map(n => Math.min(255, n + i)), [])
  assert.deepEqual(checker.findings, [])
  const bad = frameChecker(60)
  bad.add(clean, [])
  bad.add(changed, [])
  bad.add(changed, [])
  bad.add(clean, [{ value: 0.2, startTime: 50 }])
  bad.add(new Uint8Array(clean.length).fill(255), [])
  assert.deepEqual(new Set(bad.findings.map(f => f.check)), new Set(["blank", "pop-in", "flicker", "layout-shift"]))
  assert.ok(bad.findings.some(f => f.check === "flicker" && f.frame === 1 && f.endFrame === 3 && f.timeMs === 1000 / 60))
  const relaxed = frameChecker(60, { blank: 0, jump: 1, layout: 1 })
  relaxed.add(clean, []); relaxed.add(changed, [{ value: 0.2 }])
  assert.deepEqual(relaxed.findings, [])
})
