import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

// Grayscale at 64x36 suppresses antialiasing noise. Thresholds use this analysis resolution.
export const THRESHOLDS = { blank: 2, jump: 0.35, layout: 0.05, flicker: 100 }
const difference = (a, b) => a.reduce((sum, n, i) => sum + (Math.abs(n - b[i]) > 24 ? 1 : 0), 0) / a.length
export function frameChecker(fps, thresholds = {}) {
  const limits = { ...THRESHOLDS, ...thresholds }, findings = []
  let previous, index = 0, jumps = []
  return { findings, add(pixels, shifts) {
    const timeMs = index * 1000 / fps
    const flag = (check, value, frame = index, endFrame = index) => findings.push({ check, value, frame, endFrame, timeMs: frame * 1000 / fps, endTimeMs: endFrame * 1000 / fps })
    const mean = pixels.reduce((sum, n) => sum + n, 0) / pixels.length
    const deviation = Math.sqrt(pixels.reduce((sum, n) => sum + (n - mean) ** 2, 0) / pixels.length)
    if (deviation < limits.blank) flag("blank", deviation)
    for (const shift of shifts) if (shift.value > limits.layout) flag("layout-shift", shift.value)
    jumps = jumps.filter(jump => timeMs - jump.timeMs <= limits.flicker)
    for (const jump of jumps) if (difference(pixels, jump.pixels) < 0.04) {
      flag("flicker", timeMs - jump.timeMs, jump.frame, index)
      jumps = jumps.filter(other => other !== jump)
    }
    if (previous) {
      const delta = difference(pixels, previous)
      if (delta > limits.jump) {
        flag("pop-in", delta)
        jumps.push({ pixels: previous, timeMs, frame: index })
      }
    }
    previous = pixels; index++
  } }
}

export async function checkRecording(source, out, thresholds) {
  const checker = frameChecker(source.fps, thresholds)
  // Bounded to 16 MiB even at the maximum duration; decode one recording at a time.
  const raw = execFileSync("ffmpeg", ["-v", "error", "-threads", "1", "-filter_threads", "1", "-framerate", String(source.fps),
    "-i", join(source.directory, "%06d.png"), "-vf", "scale=64:36", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1"], { maxBuffer: 32 * 1024 * 1024 })
  if (raw.length !== source.count * 64 * 36) throw new Error("Frame analysis decoded an unexpected frame count")
  for (let i = 0; i < source.count; i++) checker.add(raw.subarray(i * 2304, (i + 1) * 2304), source.shifts[i])
  const name = basename(source.directory).replace("-frames", ""), thumbnails = `checks-${name}`
  await mkdir(join(out, thumbnails))
  const flagged = new Set(checker.findings.flatMap(f => [Math.max(0, f.frame - 1), f.frame, f.endFrame]))
  const indices = [...flagged].sort((a, b) => a - b)
  if (indices.length) execFileSync("ffmpeg", ["-v", "error", "-threads", "1", "-filter_threads", "1", "-framerate", String(source.fps),
    "-i", join(source.directory, "%06d.png"), "-vf", `select='${indices.map(i => `eq(n,${i})`).join("+")}',scale=320:-1`,
    "-threads", "1", "-fps_mode", "vfr", "-start_number", "0", join(out, thumbnails, "%06d.png")])
  const report = { recording: name, fps: source.fps, frames: source.count, thresholds, passed: checker.findings.length === 0, findings: checker.findings }
  await writeFile(join(out, `${name}-checks.json`), JSON.stringify(report, null, 2) + "\n")
  await writeFile(join(out, `${name}-checks.md`), `# ${name} frame checks\n\n${report.passed ? "PASS" : "FAIL"}. Frame numbers are zero-based captured samples; timestamps use app time.\n\n` +
    checker.findings.map(f => `- ${f.check}: frames ${f.frame}-${f.endFrame}, ${f.timeMs.toFixed(2)}ms, value ${f.value.toFixed(4)}\n  ` +
      [...new Set([Math.max(0, f.frame - 1), f.frame, f.endFrame])].map(i => `![Frame ${i}](${thumbnails}/${String(indices.indexOf(i)).padStart(6, "0")}.png)`).join(" ")).join("\n"))
  return report.passed
}
