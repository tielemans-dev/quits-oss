import { useEffect, useRef, type RefObject } from "react"

import { prefersReducedMotion } from "../../lib/motion"
import { cn } from "../../lib/utils"
import { CELL, createMurmuration } from "./murmuration"

const FRAME_MS = 1000 / 30

/**
 * The sky behind the greeting: a faint grid of cells and the murmuration flying across it (see
 * `murmuration.ts`), fading out at every side so it has no edge. It is decoration,
 * hidden from assistive technology and never in the way of a click.
 *
 * It runs at 30 frames a second, and only while it is on screen and the tab is visible. With
 * reduced motion it is one still frame. Colours come from the theme and follow it when it changes.
 * The flock fades around `clearRef`, so the words over it stay legible, and scatters from the
 * pointer anywhere over the parent element.
 */
export function MurmurationSky({ clearRef, className }: { clearRef: RefObject<HTMLElement | null>; className?: string }) {
  const host = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const root = host.current
    const canvas = canvasRef.current
    const area = root?.parentElement
    // Without these observers (old browsers, test DOMs) the sky stays an empty grid.
    if (!root || !canvas || !area || typeof ResizeObserver === "undefined" || typeof IntersectionObserver === "undefined") return
    const flock = createMurmuration(canvas)
    if (!flock) return
    const still = prefersReducedMotion()
    let frame = 0
    let last = 0
    let ready = false
    let onScreen = true

    const readColors = () => {
      const css = getComputedStyle(root)
      const read = (name: string) => css.getPropertyValue(name).trim() || css.color
      flock.setColors({ ink: read("--foreground"), paper: read("--background"), accents: [read("--brand"), read("--settled")] })
    }
    const measure = () => {
      const box = root.getBoundingClientRect()
      flock.resize(box.width, box.height, window.devicePixelRatio)
      const words = clearRef.current?.getBoundingClientRect()
      flock.setClear(
        words
          ? { x: words.left - box.left + words.width / 2, y: words.top - box.top + words.height / 2, rx: words.width / 2 + 48, ry: words.height / 2 + 32 }
          : null
      )
    }
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop)
      if (now - last < FRAME_MS) return
      flock.tick(last ? (now - last) / 1000 : 0)
      last = now
    }
    const sync = () => {
      const run = ready && !still && onScreen && !document.hidden
      if (run && !frame) {
        last = 0
        frame = requestAnimationFrame(loop)
      } else if (!run && frame) {
        cancelAnimationFrame(frame)
        frame = 0
      }
    }
    // A resize or a new theme clears the canvas; a stopped sky draws itself again where it was.
    const redraw = () => {
      if (ready && !frame) flock.still()
    }

    readColors()
    measure()
    const resizes = new ResizeObserver(() => {
      measure()
      redraw()
    })
    resizes.observe(root)
    const sightings = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true
      sync()
    })
    sightings.observe(root)
    const themes = new MutationObserver(() => {
      readColors()
      redraw()
    })
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    document.addEventListener("visibilitychange", sync)

    const point = (event: PointerEvent) => {
      const box = root.getBoundingClientRect()
      flock.setPointer({ x: event.clientX - box.left, y: event.clientY - box.top })
    }
    const leave = () => flock.setPointer(null)
    if (!still) {
      area.addEventListener("pointermove", point)
      area.addEventListener("pointerleave", leave)
    }

    // The glyphs are Geist Mono; wait for it, but never longer than the font takes to fail.
    let cancelled = false
    Promise.resolve(document.fonts?.load(`500 10px "Geist Mono Variable"`))
      .catch(() => undefined)
      .then(() => {
        if (cancelled) return
        ready = true
        flock.still()
        sync()
      })

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      resizes.disconnect()
      sightings.disconnect()
      themes.disconnect()
      document.removeEventListener("visibilitychange", sync)
      area.removeEventListener("pointermove", point)
      area.removeEventListener("pointerleave", leave)
    }
  }, [clearRef])

  const line = "var(--neutral-6) 1px, transparent 1px"
  return (
    <div
      ref={host}
      aria-hidden="true"
      data-slot="murmuration"
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
      style={{
        maskImage: "linear-gradient(to bottom, transparent, #000 14%, #000 62%, transparent), linear-gradient(to right, transparent, #000 10%, #000 90%, transparent)",
        maskComposite: "intersect",
      }}
    >
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `linear-gradient(to right, ${line}), linear-gradient(to bottom, ${line})`,
          backgroundSize: `${CELL.width}px ${CELL.height}px`,
        }}
      />
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
      {/* A soft haze behind the words, as if they were nearer than the birds. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_22rem_8rem_at_50%_50%,var(--background)_30%,transparent)] opacity-90" />
    </div>
  )
}
