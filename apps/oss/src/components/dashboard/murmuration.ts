/**
 * Sort sol: a murmuration of starlings, drawn as ASCII on a grid of cells, for the top of the
 * Overblik. The flock is a soft sheet of birds in 3D that bends, twists and turns; seen edge-on it
 * thickens into dark ribbons, as a real murmuration does. Each frame the birds are counted into
 * cells, the counts blurred into one body, and each cell drawn by how full it is: a speck at the
 * edge, a glyph further in, a tinted cell with a light glyph in the core.
 *
 * Plain canvas and no DOM beyond it, so the page decides when it runs (see `MurmurationSky`).
 */

export type MurmurationColors = { ink: string; paper: string; accents: readonly [string, string] }
/** An ellipse, in px of the canvas, where the flock fades so the words over it stay legible. */
export type ClearZone = { x: number; y: number; rx: number; ry: number }

export const CELL = { width: 9, height: 13 } as const
const BIRDS = 4200
const RAMP = [":", ";", "o", "t", "x", "X", "S", "%", "8", "@"]
const SPECKS = [".", "'", ",", "-", "`"]

/** A small deterministic generator, so every visit starts from the same flock. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A stable value in [0, 1) for a cell, so its glyph does not flicker while the flock holds still. */
function hash(n: number) {
  n = Math.imul(n ^ 0x27d4eb2d, 0x165667b1)
  n ^= n >>> 15
  return ((n >>> 0) % 10000) / 10000
}

function smoothstep(from: number, to: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - from) / (to - from)))
  return t * t * (3 - 2 * t)
}

export function createMurmuration(canvas: HTMLCanvasElement, startAt = 60) {
  const context = canvas.getContext("2d")
  if (!context) return null
  const ctx = context
  const rand = random(7)
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())
  const clamp = (value: number) => Math.max(-2.8, Math.min(2.8, value))

  // Where each bird sits in the sheet, and its own flutter. A few stragglers sit further out.
  const u = new Float32Array(BIRDS), v = new Float32Array(BIRDS)
  const phase = new Float32Array(BIRDS), rate = new Float32Array(BIRDS)
  for (let i = 0; i < BIRDS; i++) {
    const spread = rand() < 0.015 ? 1.8 : 1
    u[i] = clamp(gauss()) * spread
    v[i] = clamp(gauss()) * spread
    phase[i] = rand() * Math.PI * 2
    rate[i] = 0.6 + rand() * 1.6
  }
  // How far each bird has fled the pointer, in px, sprung back to its place in the flock.
  const dx = new Float32Array(BIRDS), dy = new Float32Array(BIRDS)
  const vx = new Float32Array(BIRDS), vy = new Float32Array(BIRDS)

  let width = 0, height = 0, cols = 0, rows = 0, dpr = 1
  let counts = new Float32Array(0), body = new Float32Array(0)
  // Until the page gives the theme's colours, everything is drawn in black.
  let colors: MurmurationColors = { ink: "black", paper: "black", accents: ["black", "black"] }
  let clear: ClearZone | null = null
  let pointer: { x: number; y: number } | null = null
  let t = startAt

  function step(dt: number) {
    t += dt
    const scale = Math.min(Math.max(width * 0.1, 72), height * 0.34) * (1 + 0.14 * Math.sin(0.09 * t))
    // The flock circles the words, wandering off the ellipse a little: it mostly flies in the
    // open space around them and now and then passes behind.
    const orbit = 0.061 * t
    const cx = width * (0.5 + 0.3 * Math.cos(orbit) + 0.05 * Math.sin(0.13 * t + 2))
    const cy = height * (0.5 + 0.3 * Math.sin(orbit) + 0.06 * Math.sin(0.19 * t + 1))
    const twist = 1.3 * Math.sin(0.13 * t + 0.4)
    const yaw = 0.9 * Math.sin(0.057 * t) + 0.35 * Math.sin(0.17 * t + 1.3)
    const pitch = 0.5 + 0.5 * Math.sin(0.083 * t + 1)
    const roll = 0.35 * Math.sin(0.061 * t + 2.2)
    const cyaw = Math.cos(yaw), syaw = Math.sin(yaw)
    const cp = Math.cos(pitch), sp = Math.sin(pitch)
    const cr = Math.cos(roll), sr = Math.sin(roll)

    counts.fill(0)
    for (let i = 0; i < BIRDS; i++) {
      const ui = u[i], vi = v[i]
      // A long, thin body that bends like an S and swells and narrows along its length.
      const swell = 0.55 + 0.45 * Math.sin(0.9 * ui + 0.23 * t + 0.6)
      const x = ui * 1.25 + 0.12 * Math.sin(1.4 * vi + 0.31 * t)
      const y = vi * 0.34 * swell + 0.42 * Math.sin(0.8 * ui + 0.27 * t) + 0.12 * Math.sin(2.3 * ui - 0.41 * t)
      const z = 0.6 * Math.sin(1.2 * ui + 0.33 * t) + 0.3 * Math.sin(2.4 * vi + 0.27 * t + 1.7)
      // A twist along its length, like a ribbon, then the whole flock turning.
      const ca = Math.cos(twist * ui), sa = Math.sin(twist * ui)
      const y1 = y * ca - z * sa, z1 = y * sa + z * ca
      const x2 = x * cyaw + z1 * syaw, z2 = -x * syaw + z1 * cyaw
      const y2 = y1 * cp - z2 * sp
      const flutter = rate[i] * t + phase[i]
      let px = cx + (x2 * cr - y2 * sr + 0.035 * Math.sin(flutter)) * scale
      let py = cy + (x2 * sr + y2 * cr + 0.035 * Math.cos(flutter * 1.3)) * scale

      if (pointer || dx[i] || dy[i] || vx[i] || vy[i]) {
        // A falcon: birds near the pointer burst away from it and spring back.
        let fx = 0, fy = 0
        if (pointer) {
          const ox = px + dx[i] - pointer.x, oy = py + dy[i] - pointer.y
          const d = Math.hypot(ox, oy)
          if (d < 90 && d > 0.001) {
            fx = (ox / d) * (1 - d / 90) * 2600
            fy = (oy / d) * (1 - d / 90) * 2600
          }
        }
        vx[i] += (fx - 7 * dx[i] - 4.2 * vx[i]) * dt
        vy[i] += (fy - 7 * dy[i] - 4.2 * vy[i]) * dt
        dx[i] += vx[i] * dt
        dy[i] += vy[i] * dt
        if (Math.abs(dx[i]) + Math.abs(dy[i]) + Math.abs(vx[i]) + Math.abs(vy[i]) < 0.1) dx[i] = dy[i] = vx[i] = vy[i] = 0
        px += dx[i]
        py += dy[i]
      }

      // Birds nearer the eye count for more, so the flock has a near side and a far side.
      const col = Math.floor(px / CELL.width), row = Math.floor(py / CELL.height)
      if (col >= 0 && col < cols && row >= 0 && row < rows) counts[row * cols + col] += 0.7 + 0.6 / (1 + Math.exp(-2.2 * z2))
    }

    // A soft 3x3 blur, so the flock reads as one body with feathered edges, eased over frames.
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        let sum = 0, weight = 0
        for (let oy = -1; oy <= 1; oy++) {
          const r = row + oy
          if (r < 0 || r >= rows) continue
          for (let ox = -1; ox <= 1; ox++) {
            const c = col + ox
            if (c < 0 || c >= cols) continue
            const w = (ox ? 1 : 2) * (oy ? 1 : 2)
            sum += w * counts[r * cols + c]
            weight += w
          }
        }
        const j = row * cols + col
        body[j] = body[j] * 0.5 + (sum / weight) * 0.5
      }
    }
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    const fills: number[][] = Array.from({ length: 12 }, () => [])
    const glyphs = new Map<string, Array<string | number>>()
    const put = (key: string, glyph: string, x: number, y: number) => {
      const list = glyphs.get(key)
      if (list) list.push(glyph, x, y)
      else glyphs.set(key, [glyph, x, y])
    }
    const epoch = Math.floor(t / 3)
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const j = row * cols + col
        if (body[j] < 0.08) continue
        let level = 1 - Math.exp(-body[j] / 3.2)
        if (clear) {
          const ex = ((col + 0.5) * CELL.width - clear.x) / clear.rx
          const ey = ((row + 0.5) * CELL.height - clear.y) / clear.ry
          level *= 0.18 + 0.82 * smoothstep(0.55, 1.15, ex * ex + ey * ey)
        }
        if (level < 0.12) continue
        const x = col * CELL.width, y = row * CELL.height, h = hash(j)
        if (level < 0.5) {
          if (level < 0.3) put("ink|0.3", SPECKS[Math.floor(h * SPECKS.length)], x, y)
          else put("ink|0.6", RAMP[Math.min(3, Math.floor(h * 2 + (level - 0.3) * 10))], x, y)
          continue
        }
        const shade = Math.max(0, Math.min(11, Math.floor(((level - 0.5) / 0.5) * 12 + (hash(j * 7) - 0.5) * 4)))
        fills[shade].push(x, y)
        const glyph = RAMP[Math.min(RAMP.length - 1, Math.max(2, Math.round(((level - 0.5) / 0.5) * (RAMP.length - 2) + (h - 0.5) * 5)))]
        // Now and then a cell in the core catches the light, in one of the two accents.
        const accent = level > 0.6 && hash(j * 31 + epoch) < 0.02
        put(accent ? (hash(j + epoch) < 0.5 ? "accent0|0.9" : "accent1|0.9") : shade >= 4 ? "paper|0.9" : "ink|0.7", glyph, x, y)
      }
    }
    ctx.fillStyle = colors.ink
    fills.forEach((list, shade) => {
      ctx.globalAlpha = 0.07 + (shade / 11) * 0.5
      for (let k = 0; k < list.length; k += 2) ctx.fillRect(list[k] + 1, list[k + 1] + 1, CELL.width - 1, CELL.height - 1)
    })
    ctx.font = `500 10px "Geist Mono Variable", ui-monospace, monospace`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    for (const [key, list] of glyphs) {
      const [tone, alpha] = key.split("|")
      ctx.fillStyle = tone === "paper" ? colors.paper : tone === "accent0" ? colors.accents[0] : tone === "accent1" ? colors.accents[1] : colors.ink
      ctx.globalAlpha = Number(alpha)
      for (let k = 0; k < list.length; k += 3) {
        ctx.fillText(list[k] as string, (list[k + 1] as number) + CELL.width / 2 + 0.5, (list[k + 2] as number) + CELL.height / 2 + 1)
      }
    }
    ctx.globalAlpha = 1
  }

  return {
    resize(nextWidth: number, nextHeight: number, nextDpr: number) {
      width = nextWidth
      height = nextHeight
      dpr = Math.min(2, nextDpr || 1)
      cols = Math.ceil(width / CELL.width)
      rows = Math.ceil(height / CELL.height)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      counts = new Float32Array(cols * rows)
      body = new Float32Array(cols * rows)
    },
    setColors(next: MurmurationColors) { colors = next },
    setClear(next: ClearZone | null) { clear = next },
    setPointer(next: { x: number; y: number } | null) { pointer = next },
    /** Moves the flock on by `dt` seconds and draws it. */
    tick(dt: number) {
      step(Math.min(dt, 0.05))
      draw()
    },
    /** One settled frame for reduced motion or a redraw after a resize: the flock where it is. */
    still() {
      for (let i = 0; i < 6; i++) step(0)
      draw()
    },
  }
}

export type Murmuration = NonNullable<ReturnType<typeof createMurmuration>>
