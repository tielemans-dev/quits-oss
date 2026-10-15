import { parseArgs } from "node:util"
import { THRESHOLDS } from "./record-motion-checks.mjs"

export const FPS = 60
export const sampleTime = (index, fps) => index * 1000 / fps
export function sampleBudget(index, fps) {
  // CDP truncates budgets to microseconds. Round absolute times, not each delta.
  const micros = (i) => Math.round(i * 1_000_000 / fps)
  return (micros(index) - micros(index - 1)) / 1000 + 1e-7
}
export const frameCount = (seconds) => Math.ceil(seconds * FPS)
export function sheetIndices(count) {
  const length = Math.min(12, count)
  return Array.from({ length }, (_, i) => Math.round(i * (count - 1) / Math.max(1, length - 1)))
}

export function parseOptions(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    "base-url": { type: "string", default: "http://localhost:3000" },
    "before-url": { type: "string" }, "after-url": { type: "string" },
    duration: { type: "string", default: "3" }, out: { type: "string", default: "artifacts/motion" },
    width: { type: "string", default: "1280" }, height: { type: "string", default: "720" },
    scenario: { type: "string" }, "storage-state": { type: "string" }, "wait-for": { type: "string" },
    ...Object.fromEntries(Object.keys(THRESHOLDS).map(key => [`check-${key}`, { type: "string" }])),
    "keep-frames": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  } })
  if (values.help) return { help: true }
  const [route] = positionals
  if (positionals.length !== 1 || !route.startsWith("/") || route.startsWith("//")) {
    throw new Error("Supply one app route, e.g. /login. See --help.")
  }
  for (const key of ["base-url", "before-url", "after-url"]) {
    if (values[key] !== undefined && !["http:", "https:"].includes(new URL(values[key]).protocol)) {
      throw new Error(`${key} must be an HTTP(S) URL`)
    }
    if (values[key] && new URL(route, values[key]).origin !== new URL(values[key]).origin) {
      throw new Error("Route must resolve within the app's origin")
    }
  }
  const thresholds = { ...THRESHOLDS }
  for (const key of Object.keys(thresholds)) if (values[`check-${key}`] !== undefined) {
    const value = Number(values[`check-${key}`])
    if (!Number.isFinite(value) || value < 0 || (key === "blank" ? value > 255 : key === "flicker" ? value > 1000 : value > 1)) throw new Error(`Invalid check-${key} threshold`)
    thresholds[key] = value
  }
  const duration = Number(values.duration), width = Number(values.width), height = Number(values.height)
  if (!Number.isFinite(duration) || duration < 1 / FPS || duration > 30) throw new Error("duration must be 1/60 to 30 seconds")
  for (const [key, value, max] of [["width", width, 3840], ["height", height, 2160]]) {
    if (!Number.isInteger(value) || value < 64 || value > max || value % 2) throw new Error(`${key} must be an even integer, 64 to ${max}`)
  }
  if (!values.out.trim()) throw new Error("out must not be empty")
  return { ...values, route, duration, width, height, thresholds,
    before: values["before-url"] ?? values["after-url"] ?? values["base-url"],
    after: values["after-url"] ?? values["base-url"],
  }
}
