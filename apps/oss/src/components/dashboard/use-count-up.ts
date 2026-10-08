import { useEffect, useRef, useState } from "react"

const DURATION_MS = 700

function motionAllowed(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

/**
 * Counts a figure up from zero once, the first time it appears, over 700ms. Later changes (the
 * summary reloads after a reminder) jump straight to the new value, and with reduced motion the
 * first value appears at once too. The value is minor units, so no rounding reaches a price.
 */
export function useCountUp(target: bigint): bigint {
  const [value, setValue] = useState<bigint>(() =>
    motionAllowed() && target > 0n ? 0n : target
  )
  const played = useRef(false)

  useEffect(() => {
    if (played.current || target === 0n || target > BigInt(Number.MAX_SAFE_INTEGER) || !motionAllowed()) {
      played.current = true
      setValue(target)
      return
    }
    const start = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / DURATION_MS)
      const eased = 1 - (1 - progress) ** 3
      setValue(BigInt(Math.round(Number(target) * eased)))
      if (progress < 1) {
        frame = requestAnimationFrame(tick)
      } else {
        played.current = true
      }
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target])

  return value
}
