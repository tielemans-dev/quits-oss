// Explicit local check: requires ffmpeg and Playwright Chromium; excluded from CI test globs.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { test } from "node:test"

test("readiness and scenario hooks, frame retention, and retry after failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "quits-recording-")), scenario = join(root, "scenario.mjs")
  const server = createServer((_, response) => response.end(`<script>setTimeout(() => {
    document.body.innerHTML = '<input id="ready">'
  }, 800)</script>`))
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  const record = (name, extra = []) => promisify(execFile)(process.execPath, [fileURLToPath(new URL("./record-motion.mjs", import.meta.url)),
    "/", "--base-url", `http://127.0.0.1:${server.address().port}`, "--duration", "0.05", "--width", "64", "--height", "64",
    "--wait-for", "#ready", "--scenario", scenario, "--out", join(root, name), ...extra], { timeout: 30_000 })
  const source = `import {appendFileSync} from 'node:fs'
    export async function prepare(page) { await page.locator('#ready').fill('prepared') }
    export async function frame(page, {index}) { if (index === 0) {
      if (await page.locator('#ready').inputValue() !== 'prepared') throw Error('prepare did not run')
      appendFileSync(${JSON.stringify(join(root, "audit"))}, 'frame\\n')
    } }`
  try {
    await writeFile(scenario, source)
    await record("default")
    assert.equal((await readdir(join(root, "default"))).some((name) => name.endsWith("-frames")), false)
    assert.equal(await readFile(join(root, "audit"), "utf8"), "frame\nframe\n")
    assert.equal(JSON.parse(await readFile(join(root, "default", "after-checks.json"), "utf8")).passed, true)
    await record("kept", ["--keep-frames"])
    assert.equal((await readdir(join(root, "kept", "after-frames"))).length, 12)
    await writeFile(scenario, "export function prepare(page) { return page.evaluate(() => document.body.innerHTML = '') }")
    await assert.rejects(record("blank", ["--wait-for", "body"]), /Frame checks failed/)
    const report = JSON.parse(await readFile(join(root, "blank", "after-checks.json"), "utf8"))
    assert.equal(report.passed, false)
    assert.ok(report.findings.some(f => f.check === "blank" && f.frame === 0))
    assert.ok((await readdir(join(root, "blank", "checks-after"))).length > 0)
    assert.ok((await readdir(join(root, "blank"))).includes("1x.mp4"))
    await writeFile(scenario, `export function prepare(page) { return page.evaluate(() => {
      document.body.innerHTML = '<div style="height:40px;width:40px;background:#333">text</div>'
    }) }
    export function frame(page, {index}) { return page.evaluate(index => {
      document.body.style.background = index === 1 ? '#111' : '#fff'
      document.body.style.paddingTop = index === 1 ? '32px' : '0'
    }, index) }`)
    await assert.rejects(record("glitches", ["--wait-for", "body"]), /Frame checks failed/)
    const glitches = JSON.parse(await readFile(join(root, "glitches", "after-checks.json"), "utf8"))
    for (const check of ["pop-in", "flicker", "layout-shift"]) assert.ok(glitches.findings.some(f => f.check === check), check)
    await writeFile(scenario, "export function prepare() { throw Error('intentional failure') }")
    await assert.rejects(record("retry"), /intentional failure/)
    assert.equal((await readdir(root)).some((name) => name.startsWith("retry")), false)
    await writeFile(scenario, source)
    await record("retry")
  } finally { server.close(); await rm(root, { recursive: true, force: true }) }
})
