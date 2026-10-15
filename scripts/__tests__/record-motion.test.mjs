import assert from "node:assert/strict"
import { test } from "node:test"
import { FPS, frameCount, parseOptions, sampleBudget, sampleTime, sheetIndices } from "../record-motion-options.mjs"

test("CDP microsecond budget truncation never accumulates frame timing drift", () => {
  for (const fps of [60, 240]) {
    let micros = 0
    for (let i = 1; i < 30 * fps; i++) {
      micros += Math.trunc(sampleBudget(i, fps) * 1000)
      assert.equal(micros, Math.round(sampleTime(i, fps) * 1000))
    }
  }
})

test("240Hz sampling preserves 1x duration and gives quarter speed distinct 60fps frames", () => {
  for (const duration of [1 / 60, 0.333, 1, 3.01, 30]) {
    const normal = frameCount(duration), slow = normal * 4
    assert.ok(normal / FPS >= duration)
    assert.ok(normal / FPS - duration < 1 / FPS)
    assert.equal(slow / FPS, normal / FPS * 4)
    for (let i = 0; i < normal; i++) assert.equal(sampleTime(i * 4, 240), sampleTime(i, 60))
    assert.ok(sampleTime(slow - 1, 240) < normal / FPS * 1000)
  }
  assert.deepEqual(sheetIndices(1), [0])
  assert.deepEqual(sheetIndices(4), [0, 1, 2, 3])
  const sheet = sheetIndices(720)
  assert.equal(sheet.length, 12)
  assert.equal(sheet[0], 0)
  assert.equal(sheet.at(-1), 719)
})

test("route and comparison URL defaults work with explicit overrides and equals syntax", () => {
  const defaults = parseOptions(["/login?lang=en"])
  assert.equal(defaults.route, "/login?lang=en")
  assert.equal(defaults.before, defaults.after)
  assert.equal(defaults.duration, 3)
  const custom = parseOptions(["/login", "--base-url=http://localhost:3100", "--before-url", "http://localhost:3101",
    "--after-url", "https://example.test", "--duration", "0.5", "--width", "800", "--height", "600", "--out", "/tmp/review"])
  assert.equal(custom.before, "http://localhost:3101")
  assert.equal(custom.after, "https://example.test")
  assert.equal(custom.width, 800)
  assert.equal(custom.height, 600)
  assert.equal(custom.duration, 0.5)
  const afterOnly = parseOptions(["/login", "--after-url", "http://localhost:3102"])
  assert.equal(afterOnly.before, afterOnly.after)
  assert.deepEqual(parseOptions(["--help"]), { help: true })
})

test("reject malformed input before opening a browser or creating outputs", () => {
  for (const args of [[], ["login"], ["//example.test"], ["/\\evil.test/x"], ["/\t/evil.test"], ["/", "/extra"], ["/", "--unknown"],
    ["/", "--duration", "NaN"], ["/", "--duration", "Infinity"], ["/", "--duration", "0"], ["/", "--duration", "31"],
    ["/", "--width", "801"], ["/", "--height", "0"], ["/", "--height", "2162"],
    ["/", "--base-url", "file:///tmp"], ["/", "--before-url", "bad"], ["/", "--out", " "]]) {
    assert.throws(() => parseOptions(args), undefined, JSON.stringify(args))
  }
})

test("accept readiness/scenario paths and opt-in frame retention", () => {
  const options = parseOptions(["/login", "--wait-for", "#email", "--scenario", "./review flow.mjs", "--keep-frames"])
  assert.equal(options["wait-for"], "#email")
  assert.equal(options.scenario, "./review flow.mjs")
  assert.equal(options["keep-frames"], true)
  assert.equal(parseOptions(["/login"])["keep-frames"], false)
})
