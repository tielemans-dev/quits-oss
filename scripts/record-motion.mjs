#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { resolve, join } from "node:path"
import { pathToFileURL } from "node:url"
import { FPS, frameCount, parseOptions, sampleBudget, sampleTime, sheetIndices } from "./record-motion-options.mjs"

const help = `Usage: node scripts/record-motion.mjs /route [options]
--base-url URL       Running app (default http://localhost:3000)
--before-url URL     Baseline app; defaults to the after app
--after-url URL      Candidate app; defaults to --base-url
--duration SECONDS  App time, rounded up to a 60fps frame (default 3, max 30)
--out DIRECTORY     New output directory (default artifacts/motion)
--keep-frames       Retain raw PNG sequences for inspection
--width N --height N  Even viewport dimensions (default 1280 x 720)
--wait-for SELECTOR Wait for a hydrated page element before capture
--storage-state FILE  Playwright auth state, optional
--scenario FILE     Module exporting optional prepare(page), frame(page, {timeMs, index, fps})
Requires ffmpeg with libx264, ffprobe, and Playwright Chromium headless shell.
See docs/recording-motion.md for interaction hooks, limitations, and outputs.`

const run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
function ffmpeg(args) {
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-n", "-filter_threads", "2", "-filter_complex_threads", "2", ...args])
}
const codec = ["-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-fps_mode", "passthrough"]

async function within(operation) {
  let timer
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Frame timed out; hooks must not wait on paused time")), 30_000)
    })])
  } finally { clearTimeout(timer) }
}

async function capture(browser, options, baseURL, reducedMotion, directory, scenario) {
  await mkdir(directory)
  const context = await browser.newContext({ viewport: { width: options.width, height: options.height },
    deviceScaleFactor: 1, reducedMotion, storageState: options["storage-state"] })
  try {
    const page = await context.newPage()
    const response = await page.goto(new URL(options.route, baseURL).href, { waitUntil: "networkidle" })
    if (!response?.ok()) throw new Error(`Route returned HTTP ${response?.status()}`)
    if (options["wait-for"]) await page.locator(options["wait-for"]).waitFor()
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    await scenario.prepare?.(page)
    const cdp = await context.newCDPSession(page)
    const { virtualTimeTicksBase } = await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" })
    // Idle documents otherwise leave document.timeline on their last active frame.
    await page.evaluate(() => { const tick = () => requestAnimationFrame(tick); requestAnimationFrame(tick) })
    const fps = reducedMotion === "reduce" ? FPS : FPS * 4
    const count = frameCount(options.duration) * (fps / FPS)
    let origin
    for (let index = 0; index < count; index++) {
      const timeMs = sampleTime(index, fps)
      if (index) {
        // Wall time spent painting/encoding never consumes the app's next frame.
        const expired = new Promise((done) => cdp.once("Emulation.virtualTimeBudgetExpired", done))
        await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget: sampleBudget(index, fps) })
        await within(expired)
      }
      await within(scenario.frame?.(page, { timeMs, index, fps }))
      const { screenshotData } = await cdp.send("HeadlessExperimental.beginFrame", {
        frameTimeTicks: virtualTimeTicksBase + timeMs, interval: 1000 / fps,
        screenshot: { format: "png" },
      })
      if (!screenshotData) throw new Error(`Chromium did not capture frame ${index}`)
      const clocks = await page.evaluate(() => [performance.now(), document.timeline.currentTime])
      origin ??= clocks
      // Chromium rounds timestamps for privacy. Allow 0.25ms, well below one sample.
      if (clocks.some((now, i) => now === null || Math.abs(now - origin[i] - timeMs) > 0.25)) {
        throw new Error(`Page or compositor clock drifted at frame ${index}: ${JSON.stringify({ clocks, origin, timeMs })}`)
      }
      await writeFile(join(directory, `${String(index).padStart(6, "0")}.png`), Buffer.from(screenshotData, "base64"))
    }
    return { directory, count, fps }
  } finally { await context.close() }
}

function encode(source, target, stride = 1) {
  ffmpeg(["-framerate", String(FPS), "-i", join(source.directory, "%06d.png"),
    "-vf", `select=not(mod(n\\,${stride})),setpts=N/(${FPS}*TB)`, ...codec, target])
  return source.count / stride
}

function verify(file, count) {
  const { streams: [stream] } = JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=avg_frame_rate,nb_read_frames,duration", "-of", "json", file]))
  if (stream.avg_frame_rate !== "60/1" || Number(stream.nb_read_frames) !== count ||
    Math.abs(Number(stream.duration) - count / FPS) > 0.001) throw new Error(`Frame count/rate/duration mismatch: ${file}`)
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  if (options.help) { console.log(help); return }
  let encoders
  try { encoders = run("ffmpeg", ["-hide_banner", "-encoders"]) }
  catch { throw new Error("ffmpeg is unavailable. Install ffmpeg with libx264 and put it on PATH.") }
  if (!/^\s*V\S*\s+libx264\s/m.test(encoders)) throw new Error("ffmpeg lacks libx264. Install an ffmpeg build with the libx264 encoder.")
  try { run("ffprobe", ["-version"]) }
  catch { throw new Error("ffprobe is unavailable. Install ffmpeg/ffprobe and put them on PATH.") }
  const scenario = options.scenario ? await import(pathToFileURL(resolve(options.scenario)).href) : {}
  const { chromium } = createRequire(new URL("../apps/oss/package.json", import.meta.url))("@playwright/test")
  const target = resolve(options.out)
  if (await lstat(target).then(() => true, (error) => { if (error.code !== "ENOENT") throw error; return false })) {
    throw new Error(`Output already exists: ${target}`)
  }
  await mkdir(resolve(target, ".."), { recursive: true })
  const out = await mkdtemp(`${target}.tmp-`)
  let browser
  try {
    browser = await chromium.launch({ args: ["--deterministic-mode", "--enable-begin-frame-control"] })
    console.log("Capturing after at 240 samples per app second...")
    const after = await capture(browser, options, options.after, "no-preference", join(out, "after-frames"), scenario)
    const before = options.before === options.after ? after :
      await capture(browser, options, options.before, "no-preference", join(out, "before-frames"), scenario)
    console.log("Capturing prefers-reduced-motion at 60 samples per app second...")
    const reduced = await capture(browser, options, options.after, "reduce", join(out, "reduced-frames"), scenario)
    const outputs = [["1x.mp4", encode(after, join(out, "1x.mp4"), 4)],
      ["0.25x.mp4", encode(after, join(out, "0.25x.mp4"))],
      ["reduced-motion.mp4", encode(reduced, join(out, "reduced-motion.mp4"))]]
    encode(before, join(out, "before-1x.mp4"), 4)
    ffmpeg(["-i", join(out, "before-1x.mp4"), "-i", join(out, "1x.mp4"),
      "-filter_complex", "hstack=inputs=2", ...codec, join(out, "before-after.mp4")])
    outputs.push(["before-1x.mp4", before.count / 4], ["before-after.mp4", after.count / 4])
    const indices = sheetIndices(after.count)
    ffmpeg(["-framerate", String(FPS), "-i", join(after.directory, "%06d.png"), "-vf",
      `select='${indices.map((n) => `eq(n,${n})`).join("+")}',scale=320:-1,tile=4x3`,
      "-frames:v", "1", "-update", "1", join(out, "frames.png")])
    for (const [name, count] of outputs) verify(join(out, name), count)
    await writeFile(join(out, "manifest.json"), JSON.stringify({ route: options.route, before: options.before, after: options.after,
      fps: FPS, duration: frameCount(options.duration) / FPS, viewport: { width: options.width, height: options.height },
      samples: { after: after.count, before: before.count, reduced: reduced.count }, outputs,
      sheetTimesMs: indices.map((i) => sampleTime(i, FPS * 4)),
    }, null, 2) + "\n")
    if (!options["keep-frames"]) for (const name of ["after", "before", "reduced"]) {
      await rm(join(out, `${name}-frames`), { recursive: true, force: true })
    }
    await browser.close()
    await rename(out, target)
    console.log(`Verified 60fps MP4s, frame sheet, and manifest: ${target}`)
  } finally {
    try { await browser?.close() }
    finally { await rm(out, { recursive: true, force: true }) }
  }
}

main().catch((error) => { console.error(error.message, error.stderr?.toString() ?? ""); process.exitCode = 1 })
