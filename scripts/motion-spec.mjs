// Motion spec rules that check-motion enforces on the app's CSS. Each function returns failure messages.
export const SPATIAL_MAX_MS = 350
export const NON_SPATIAL = new Set(["count", "highlight", "spin", "pulse"])

const FADE = "var(--duration-fade)"
const FADE_PROPERTIES = new Set(["opacity", "color", "background-color", "border-color", "text-decoration-color", "fill", "stroke", "outline-color", "box-shadow"])
const KEYFRAME_PROPERTIES = new Set(["opacity", "background-color", "color"])
// Under reduced motion the universal rule has to leave these values: no slide, zoom, spin or blur, a fade to or from transparent.
const UNIVERSAL_VALUES = {
  "transition-duration": FADE,
  "--tw-animation-duration": FADE,
  "--tw-enter-opacity": "0", "--tw-exit-opacity": "0",
  "--tw-enter-translate-x": "0", "--tw-enter-translate-y": "0", "--tw-enter-scale": "1", "--tw-enter-rotate": "0", "--tw-enter-blur": "0",
  "--tw-exit-translate-x": "0", "--tw-exit-translate-y": "0", "--tw-exit-scale": "1", "--tw-exit-rotate": "0", "--tw-exit-blur": "0",
}

const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "")
const squash = (value) => value.replace(/!important/g, "").replace(/\s+/g, " ").trim()

function blocks(css, head) {
  const found = []
  for (const match of css.matchAll(head)) {
    let depth = 0
    for (let i = match.index + match[0].length - 1; i < css.length; i++) {
      if (css[i] === "{") depth++
      else if (css[i] === "}" && --depth === 0) { found.push({ name: match[1], body: css.slice(match.index + match[0].length, i) }); break }
    }
  }
  return found
}

function rules(body) {
  return [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, declarations]) => ({
    selector: selector.trim(),
    declarations: [...declarations.matchAll(/([\w-]+)\s*:\s*([^;]+);?/g)].map(([, property, value]) => [property, squash(value)]),
  }))
}

export function checkDurationTokens(css) {
  const failures = []
  for (const [, name, amount, unit] of strip(css).matchAll(/--duration-([\w-]+):\s*([\d.]+)(ms|s)\s*;/g)) {
    const ms = Number(amount) * (unit === "s" ? 1000 : 1)
    if (!NON_SPATIAL.has(name) && ms > SPATIAL_MAX_MS) failures.push(`--duration-${name} is ${ms}ms; spatial motion is capped at ${SPATIAL_MAX_MS}ms (non-spatial tokens: ${[...NON_SPATIAL].join(", ")})`)
  }
  return failures
}

/** `stylesheets` is a list of [path, css]; `main` is the path of the one that holds the universal reduced-motion rule. */
export function checkReducedMotion(stylesheets, main) {
  const failures = []
  const keyframes = new Map()
  for (const [file, css] of stylesheets) {
    for (const { name, body } of blocks(strip(css), /@keyframes\s+([\w-]+)\s*\{/g)) {
      keyframes.set(name, [...new Set([...body.matchAll(/([\w-]+)\s*:/g)].map((match) => match[1]))].map((property) => [property, file]))
    }
  }
  const fadeKeyframe = (name) => {
    const properties = keyframes.get(name)
    if (!properties) return null
    const movement = properties.map(([property]) => property).filter((property) => !KEYFRAME_PROPERTIES.has(property))
    return movement.length ? `${name} animates ${movement.join(", ")}` : null
  }
  let universal = false
  const overrides = new Set(), stops = new Set()
  for (const [file, css] of stylesheets) {
    for (const { body } of blocks(strip(css), /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/g)) {
      for (const { selector, declarations } of rules(body)) {
        const where = `${file}: reduced motion, ${selector}`
        const get = (property) => declarations.find(([name]) => name === property)?.[1]
        const parts = selector.split(",").map((part) => part.trim())
        if (get("animation") !== undefined || get("animation-name") !== undefined) for (const part of parts) overrides.add(part)
        if (get("animation") === "none") for (const part of parts) stops.add(part)
        if (parts.includes("*")) {
          universal ||= file === main
          for (const property of ["animation", "animation-name", "transition"]) if (get(property) !== undefined) failures.push(`${where}: \`${property}\` on everything turns fades into hard cuts; limit \`transition-property\` to opacity and colour instead`)
          for (const property of (get("transition-property") ?? "").split(",").map((part) => part.trim())) if (!FADE_PROPERTIES.has(property)) failures.push(`${where}: \`transition-property\` allows ${property || "nothing"}; only opacity and colour may transition`)
          for (const [property, value] of Object.entries(UNIVERSAL_VALUES)) if (get(property) !== value) failures.push(`${where}: \`${property}\` must be ${value}, found ${get(property) ?? "nothing"}`)
          continue
        }
        for (const [property, value] of declarations) {
          if (property === "animation-duration" && value !== FADE) failures.push(`${where}: \`animation-duration\` must be ${FADE}, found ${value}`)
          const items = property === "animation" ? value.split(/,(?![^(]*\))/) : property === "animation-name" ? value.split(",") : []
          for (const item of items.map((part) => part.trim())) {
            const names = item.split(" ").filter((token) => keyframes.has(token) || (property === "animation-name" && /^[a-z][\w-]*$/.test(token)))
            for (const name of names) {
              const problem = fadeKeyframe(name)
              if (problem) failures.push(`${where}: \`${name}\` is not a fade (${problem})`)
              const tint = keyframes.get(name)?.every(([keyframeProperty]) => keyframeProperty === "background-color")
              const duration = item.match(/var\(--duration-[\w-]+\)/)?.[0]
              if (property === "animation" && duration !== FADE && !(tint && duration === "var(--duration-highlight)")) failures.push(`${where}: \`${name}\` must last ${FADE}, found ${duration ?? item}`)
            }
          }
          if (property === "transition" && value !== "none") for (const item of value.split(/,(?![^(]*\))/)) {
            if (!FADE_PROPERTIES.has(item.trim().split(" ")[0]) || !item.includes(FADE)) failures.push(`${where}: transition \`${item.trim()}\` must be an opacity or colour fade of ${FADE}`)
          }
        }
      }
    }
  }
  // A rule that animates movement needs a reduced-motion override; spinners and pulses (Tailwind utilities) need their stop rule.
  for (const [file, css] of stylesheets) {
    for (const { selector, declarations } of rules(strip(css).replace(/@[\w-]+[^{;]*(?:;|\{(?:[^{}]|\{[^{}]*\})*\})/g, ""))) {
      const moving = declarations.filter(([property]) => property === "animation" || property === "animation-name").flatMap(([, value]) => value.split(/[\s,]+/)).map(fadeKeyframe).filter(Boolean)
      for (const part of selector.split(",").map((name) => name.trim())) if (moving.length && !overrides.has(part)) failures.push(`${file}: ${part} animates (${moving[0]}) but has no reduced motion fallback`)
    }
  }
  for (const part of [".animate-spin", ".animate-pulse"]) if (!stops.has(part)) failures.push(`${main}: reduced motion must stop ${part} with \`animation: none\``)
  if (!universal) failures.push(`${main}: missing the universal \`*, *::before, *::after\` rule inside \`@media (prefers-reduced-motion: reduce)\``)
  return failures
}
