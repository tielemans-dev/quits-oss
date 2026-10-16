import { useCallback } from "react"

import { EASE_ENTER, prefersReducedMotion } from "../../lib/motion"

/**
 * A surface whose height follows its content. Put the returned ref on the one element inside the
 * surface that holds everything; the surface (its parent) must clip its overflow. Whenever the
 * content resizes (a card opens, its data arrives, a list gives way to a card) the surface eases
 * from the height it has now to the new one, so nothing jumps, and a change midway retargets from
 * where it is. `animate` can decline a change (the palette's list resizing as you type just
 * resizes). With reduced motion the height simply changes.
 */
export function useFollowHeight(duration: number, animate: () => boolean = () => true) {
  return useCallback(
    (content: HTMLElement | null) => {
      const surface = content?.parentElement
      if (!content || !surface || typeof ResizeObserver === "undefined") return
      let height = surface.getBoundingClientRect().height
      let running: Animation | null = null
      const observer = new ResizeObserver(() => {
        const to = content.offsetHeight + surface.offsetHeight - surface.clientHeight
        const from = running ? surface.getBoundingClientRect().height : height
        height = to
        running?.cancel()
        running = null
        if (Math.abs(from - to) < 1 || typeof surface.animate !== "function" || prefersReducedMotion() || !animate()) return
        const animation = surface.animate({ height: [`${from}px`, `${to}px`] }, { duration, easing: EASE_ENTER })
        animation.onfinish = () => {
          if (running === animation) running = null
        }
        running = animation
      })
      observer.observe(content)
      return () => {
        observer.disconnect()
        running?.cancel()
      }
    },
    // The surface keeps the first `animate` it is given; pass one that reads a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [duration]
  )
}
