import { useEffect, useState } from "react"

import { cn } from "../../lib/utils"

/**
 * The Quits signature as a small mark: two rules, the second drawn in on first paint (300ms, and
 * at once with reduced motion). It stands where something is settled and there is no amount to
 * put the rules under, such as the streak line.
 */
export function DoubleRule({ className }: { className?: string }) {
  const [drawn, setDrawn] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setDrawn(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="16"
      height="10"
      viewBox="0 0 16 10"
      className={cn("shrink-0 overflow-visible", className)}
    >
      <line x1="0" x2="16" y1="2" y2="2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.5" />
      <line
        x1="0"
        x2="16"
        y1="7"
        y2="7"
        pathLength={1}
        stroke="var(--tone-success)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="1 1"
        strokeDashoffset={drawn ? 0 : 1}
        className="transition-[stroke-dashoffset] duration-300 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none"
      />
    </svg>
  )
}
