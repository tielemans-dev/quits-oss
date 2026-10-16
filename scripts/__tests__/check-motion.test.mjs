import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")
const TOKENS = "apps/oss/src/motion-tokens.css"
const STYLES = "apps/oss/src/styles.css"
const ONBOARDING = "apps/oss/src/components/onboarding-v2/onboarding-v2.css"

/** A scratch repository holding the guard and the app's real motion CSS. */
function seed(root) {
  mkdirSync(join(root, "scripts")); mkdirSync(join(root, "apps/oss/src/components/onboarding-v2"), { recursive: true })
  for (const name of ["check-motion.mjs", "motion-spec.mjs"]) writeFileSync(join(root, "scripts", name), source(`scripts/${name}`))
  for (const path of [TOKENS, STYLES, ONBOARDING]) writeFileSync(join(root, path), source(path))
  execFileSync("git", ["init", "-q", root])
  execFileSync("git", ["add", "apps"], { cwd: root })
}

/** Run the guard on the real CSS after replacing `from` with `to` in `path` (null leaves it alone). */
function guard(path, from, to) {
  const root = mkdtempSync(join(tmpdir(), "motion-spec-"))
  try {
    seed(root)
    const css = source(path)
    const mutated = css.replace(from, to)
    if (from !== null) assert.notEqual(mutated, css, `mutation did not apply: ${from}`)
    writeFileSync(join(root, path), mutated)
    const run = spawnSync(process.execPath, ["scripts/check-motion.mjs"], { cwd: root, encoding: "utf8" })
    return { status: run.status, output: run.stderr }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

test("motion guard passes on the app's tokens and reduced-motion rules", () => {
  assert.deepEqual(guard(TOKENS, null, ""), { status: 0, output: "" })
})

test("motion guard fails when a spatial duration token passes 350ms, but not a non-spatial one", () => {
  for (const [from, to] of [["--duration-card: 300ms", "--duration-card: 400ms"], ["--duration-palette: 300ms", "--duration-palette: 0.42s"], ["--duration-base: 300ms", "--duration-base: 351ms"]]) {
    const run = guard(TOKENS, from, to)
    assert.equal(run.status, 1, to)
    assert.match(run.output, /capped at 350ms/)
  }
  assert.equal(guard(TOKENS, "--duration-count: 700ms", "--duration-count: 5000ms").status, 0)
  assert.equal(guard(TOKENS, "--duration-highlight: 2400ms", "--duration-highlight: 9000ms").status, 0)
})

test("motion guard fails when reduced motion cuts instead of fading or keeps movement", () => {
  const universal = "scroll-behavior: auto !important;"
  const cases = [
    ["a global animation kill", STYLES, universal, `${universal} animation: none !important;`],
    ["a transform transition", STYLES, "outline-color, box-shadow, opacity !important", "outline-color, box-shadow, opacity, transform !important"],
    ["no transition-property limit", STYLES, /\n\s*transition-property:[^\n]*/, ""],
    ["a slower fade", STYLES, "transition-duration: var(--duration-fade) !important", "transition-duration: var(--duration-base) !important"],
    ["sheets that stay opaque while they slide", STYLES, "--tw-enter-opacity: 0 !important", "--tw-enter-opacity: 1 !important"],
    ["exits that stay opaque", STYLES, /\n\s*--tw-exit-opacity: 0 !important;/, ""],
    ["a slide that keeps moving", STYLES, "--tw-enter-translate-x: 0 !important", "--tw-enter-translate-x: 100% !important"],
    ["a tracker fade that moves", STYLES, "@keyframes tracker-fade {\n  from {\n    opacity: 0;", "@keyframes tracker-fade {\n  from {\n    opacity: 0;\n    clip-path: inset(0 round 1rem);"],
    ["an incoming row that falls back to its 300ms movement", STYLES, "animation: request-fade var(--duration-fade) var(--ease-enter) both, incoming-highlight", "animation: incoming-in var(--duration-row) var(--ease-enter) both, incoming-highlight"],
    ["a slower tracker fade", STYLES, "animation: tracker-fade var(--duration-fade)", "animation: tracker-fade var(--duration-toast)"],
    ["a tracker toast that loses its fallback", STYLES, "  .tracker-morph {\n    animation: tracker-fade var(--duration-fade) var(--ease-enter) both;\n  }\n", ""],
    ["an incoming row that loses its fallback", STYLES, /\n  \.incoming-new \{\n    animation: request-fade[^}]*\}/, ""],
    ["spinners and pulses that keep moving", STYLES, "  .animate-spin,\n  .animate-pulse {\n    animation: none !important;\n  }\n", ""],
    ["a spinner that keeps spinning", STYLES, ".animate-spin,\n  .animate-pulse {", ".animate-pulse {"],
    ["a stagger that fades slower", STYLES, "animation-name: request-fade;\n    animation-duration: var(--duration-fade);", "animation-name: request-fade;\n    animation-duration: var(--duration-base);"],
    ["an onboarding stylesheet without its reduced-motion block", ONBOARDING, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}\n/, ""],
    ["an onboarding fade that moves", ONBOARDING, "@keyframes ob-fade {\n  from {\n    opacity: 0;", "@keyframes ob-fade {\n  from {\n    opacity: 0;\n    transform: translateY(3px);"],
    ["a fill skeleton transition that is not a fade", STYLES, ".fill-slot-skeleton {\n    transition: opacity var(--duration-fade) var(--ease-enter);", ".fill-slot-skeleton {\n    transition: transform var(--duration-fade) var(--ease-enter);"],
  ]
  for (const [name, path, from, to] of cases) {
    const run = guard(path, from, to)
    assert.equal(run.status, 1, name)
    assert.match(run.output, /reduced motion/, name)
  }
})

test("motion guard fails when the reduced-motion rule or a stylesheet is missing", () => {
  assert.match(guard(STYLES, "*, *::before, *::after {\n    scroll-behavior", ".all, .all::before, .all::after {\n    scroll-behavior").output, /missing the universal/)
  const root = mkdtempSync(join(tmpdir(), "motion-spec-"))
  try {
    seed(root)
    rmSync(join(root, TOKENS))
    assert.equal(spawnSync(process.execPath, ["scripts/check-motion.mjs"], { cwd: root }).status, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("motion guard rejects variants of catch-all transitions and timing literals", () => {
  const root = mkdtempSync(join(tmpdir(), "motion-guard-"))
  try {
    seed(root)
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
