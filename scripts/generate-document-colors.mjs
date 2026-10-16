import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = new URL("../", import.meta.url)

/** Resolve the light theme to opaque sRGB colors for PDF and email renderers. */
export function documentPalette(css) {
  const light = css.match(/:root\s*\{([^}]+)\}/)?.[1]
  if (!light) throw new Error("Missing light theme :root")
  const tokens = new Map([...light.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]))
  const hex = channels => "#" + channels.map(channel => Math.round(channel).toString(16).padStart(2, "0")).join("")
  const channels = value => value.slice(1).match(/../g).map(channel => parseInt(channel, 16))
  function color(name, seen = []) {
    if (seen.includes(name)) throw new Error(`Circular color token: ${[...seen, name].join(" -> ")}`)
    const value = tokens.get(name)
    if (!value) throw new Error(`Missing color token: --${name}`)
    const alias = value.match(/^var\(--([\w-]+)\)$/)
    if (alias) return color(alias[1], [...seen, name])
    if (/^#[\da-f]{6}$/i.test(value)) return value.toLowerCase()
    // Flatten alpha onto the light panel: older mail clients and PDF engines need solid colors.
    const panel = () => channels(color("panel", [...seen, name]))
    if (value === "transparent") return hex(panel())
    const rgb = value.match(/^rgb\((\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*([\d.]+)%)?\)$/)
    const relative = value.match(/^rgb\(from var\(--([\w-]+)\) r g b \/ ([\d.]+)%\)$/)
    if (rgb || relative) {
      const foreground = relative ? channels(color(relative[1], [...seen, name])) : rgb.slice(1, 4).map(Number)
      const alpha = Number(relative ? relative[2] : rgb[4] ?? 100) / 100
      if (foreground.some(channel => channel > 255) || alpha > 1) throw new Error(`Invalid color token: --${name}`)
      return hex(panel().map((background, index) => foreground[index] * alpha + background * (1 - alpha)))
    }
    throw new Error(`Unsupported color token: --${name}: ${value}`)
  }
  const palette = Object.fromEntries(Object.entries({
    ink: "foreground", paper: "canvas", panel: "panel", body: "fg-2", muted: "muted-foreground",
    hairline: "hairline", rule: "input", fill: "muted", settled: "settled",
    settledText: "settled-text", settledSoft: "settled-soft",
  }).map(([key, token]) => [key, color(token)]))
  const panel = channels(palette.panel)
  palette.tones = Object.fromEntries(["neutral", "info", "success", "danger"].map(tone => {
    const text = color(`tone-${tone}`)
    const tint = tone === "success" ? palette.settledSoft
      : hex(channels(text).map((channel, index) => channel * 0.14 + panel[index] * 0.86))
    return [tone, { text, tint }]
  }))
  return palette
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const palette = documentPalette(readFileSync(new URL("apps/oss/src/styles.css", root), "utf8"))
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(palette))
    process.exit(0)
  }
  const output = new URL("apps/oss/src/lib/brand/document-colors.generated.ts", root)
  const source = `// Generated from the light theme in styles.css.\n// Regenerate with: node scripts/generate-document-colors.mjs\nexport const documentColors = ${JSON.stringify(palette, null, 2)} as const\n`
  if (process.argv.includes("--check")) {
    if (readFileSync(output, "utf8") !== source) throw new Error("Document palette is stale. Run node scripts/generate-document-colors.mjs")
  } else {
    writeFileSync(output, source)
  }
}
