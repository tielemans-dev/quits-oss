// Motion spec rules that check-motion enforces on the app's CSS. Each function returns failure messages.

export const SPATIAL_MAX_MS = 350
// Tokens that time something other than movement: a count-up, a tint fade, a spinner, a pulse.
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

/** Bodies of the `head { ... }` blocks, matched by braces. */
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

/** Flat `selector { declarations }` rules of a block that holds no nested blocks. */
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
  for (const [file, css] of stylesheets) {
    for (const { body } of blocks(strip(css), /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/g)) {
      for (const { selector, declarations } of rules(body)) {
        const where = `${file}: reduced motion, ${selector}`
        const get = (property) => declarations.find(([name]) => name === property)?.[1]
        if (selector.split(",").some((part) => part.trim() === "*")) {
          universal ||= file === main
          for (const property of ["animation", "animation-name", "transition"]) {
            if (get(property) !== undefined) failures.push(`${where}: \`${property}\` on everything turns fades into hard cuts; limit \`transition-property\` to opacity and colour instead`)
          }
          for (const property of (get("transition-property") ?? "").split(",").map((part) => part.trim())) {
            if (!FADE_PROPERTIES.has(property)) failures.push(`${where}: \`transition-property\` allows ${property || "nothing"}; only opacity and colour may transition`)
          }
          if (get("transition-property") === undefined) failures.push(`${where}: missing \`transition-property\` limited to opacity and colour`)
          for (const [property, value] of Object.entries(UNIVERSAL_VALUES)) {
            if (get(property) !== value) failures.push(`${where}: \`${property}\` must be ${value}, found ${get(property) ?? "nothing"}`)
          }
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
          if (property === "transition" && value !== "none") {
            for (const item of value.split(/,(?![^(]*\))/)) {
              const [target] = item.trim().split(" ")
              if (!FADE_PROPERTIES.has(target) || !item.includes(FADE)) failures.push(`${where}: transition \`${item.trim()}\` must be an opacity or colour fade of ${FADE}`)
            }
          }
        }
      }
    }
  }
  if (!universal) failures.push(`${main}: missing the universal \`*, *::before, *::after\` rule inside \`@media (prefers-reduced-motion: reduce)\``)
  return failures
}
