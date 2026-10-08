import { useRouterState } from "@tanstack/react-router"
import { useLayoutEffect, type ReactNode } from "react"

import { applyTheme, useTheme } from "../lib/theme"

/**
 * Keeps the `dark` class on <html> right for the current page. The inline script in the document
 * head sets it before first paint; this re-applies it when the route changes (public document
 * pages are always light, wherever you came from) and keeps `useTheme` subscribed to the system
 * setting and to other tabs.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const { preference } = useTheme()

  // `applyTheme` reads the stored preference itself: during hydration `preference` is still the
  // server's "system", and applying that would undo what the head script chose.
  useLayoutEffect(() => {
    applyTheme(pathname)
  }, [pathname, preference])

  return children
}
