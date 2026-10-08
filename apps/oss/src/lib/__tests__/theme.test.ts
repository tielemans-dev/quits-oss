// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  THEME_COLORS,
  THEME_STORAGE_KEY,
  applyTheme,
  isPublicDocumentPath,
  parseThemePreference,
  resetThemeForTesting,
  resolveTheme,
  themeInitScript,
  useTheme,
} from "../theme"

function stubSystemTheme(initiallyDark: boolean) {
  const listeners = new Set<() => void>()
  const query = {
    matches: initiallyDark,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }
  window.matchMedia = vi.fn(() => query) as unknown as typeof window.matchMedia
  return {
    listeners,
    setDark(dark: boolean) {
      query.matches = dark
      for (const listener of listeners) listener()
    },
  }
}

const isDark = () => document.documentElement.classList.contains("dark")
const themeColors = () =>
  Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')).map(
    (meta) => meta.content
  )

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.className = ""
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove())
  window.history.pushState({}, "", "/")
  resetThemeForTesting()
})

afterEach(() => {
  cleanup()
})

describe("theme preference", () => {
  it("falls back to system for anything it does not know", () => {
    expect(parseThemePreference("dark")).toBe("dark")
    expect(parseThemePreference("light")).toBe("light")
    expect(parseThemePreference("system")).toBe("system")
    expect(parseThemePreference("sepia")).toBe("system")
    expect(parseThemePreference(null)).toBe("system")
  })

  it("follows the system only while the preference is system", () => {
    const resolve = (preference: "system" | "light" | "dark", systemPrefersDark: boolean) =>
      resolveTheme({ preference, systemPrefersDark, pathname: "/invoices" })

    expect(resolve("system", true)).toBe("dark")
    expect(resolve("system", false)).toBe("light")
    expect(resolve("light", true)).toBe("light")
    expect(resolve("dark", false)).toBe("dark")
  })

  it("always renders public document pages light", () => {
    for (const pathname of ["/pay/abc", "/q/abc", "/a/abc", "/a/abc/", "/pay/abc.pdf"]) {
      expect(isPublicDocumentPath(pathname)).toBe(true)
      expect(resolveTheme({ preference: "dark", systemPrefersDark: true, pathname })).toBe("light")
    }
    for (const pathname of ["/", "/invoices", "/quotes/q1", "/agreements/a1", "/payments", "/api/x"]) {
      expect(isPublicDocumentPath(pathname)).toBe(false)
    }
  })
})

describe("themeInitScript", () => {
  function runInitScript() {
    new Function(themeInitScript)()
  }

  it("applies a stored dark preference before first paint", () => {
    stubSystemTheme(false)
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark")
    runInitScript()
    expect(isDark()).toBe(true)
  })

  it("follows the system when nothing is stored or the preference is system", () => {
    stubSystemTheme(true)
    runInitScript()
    expect(isDark()).toBe(true)

    document.documentElement.className = ""
    window.localStorage.setItem(THEME_STORAGE_KEY, "system")
    runInitScript()
    expect(isDark()).toBe(true)
  })

  it("lets an explicit light preference beat a dark system", () => {
    stubSystemTheme(true)
    window.localStorage.setItem(THEME_STORAGE_KEY, "light")
    document.documentElement.classList.add("dark")
    runInitScript()
    expect(isDark()).toBe(false)
  })

  it("keeps public document pages light whatever is stored", () => {
    stubSystemTheme(true)
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark")
    window.history.pushState({}, "", "/pay/some-token")
    runInitScript()
    expect(isDark()).toBe(false)
  })

  it("still works when storage is unavailable", () => {
    stubSystemTheme(true)
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied")
    })
    runInitScript()
    expect(isDark()).toBe(true)
    getItem.mockRestore()
  })

  it("works when matchMedia is missing", () => {
    // @ts-expect-error simulating an environment without matchMedia
    window.matchMedia = undefined
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark")
    runInitScript()
    expect(isDark()).toBe(true)

    window.localStorage.clear()
    document.documentElement.className = ""
    runInitScript()
    expect(isDark()).toBe(false)
  })

  it("sets one theme-color meta from the resolved theme, not from the system", () => {
    document.head.innerHTML = '<meta name="theme-color" content="#fcfcf9">'

    stubSystemTheme(false)
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark")
    runInitScript()
    expect(themeColors()).toEqual([THEME_COLORS.dark])

    stubSystemTheme(true)
    window.localStorage.setItem(THEME_STORAGE_KEY, "light")
    runInitScript()
    expect(themeColors()).toEqual([THEME_COLORS.light])

    window.localStorage.setItem(THEME_STORAGE_KEY, "dark")
    window.history.pushState({}, "", "/q/some-token")
    runInitScript()
    expect(themeColors()).toEqual([THEME_COLORS.light])
  })

  it("creates the theme-color meta when the document has none", () => {
    stubSystemTheme(true)
    runInitScript()
    expect(themeColors()).toEqual([THEME_COLORS.dark])
  })

  it("agrees with resolveTheme", () => {
    for (const stored of [null, "system", "light", "dark"]) {
      for (const systemDark of [false, true]) {
        for (const pathname of ["/", "/invoices", "/pay/t", "/q/t", "/a/t"]) {
          stubSystemTheme(systemDark)
          document.documentElement.className = ""
          window.localStorage.clear()
          if (stored) window.localStorage.setItem(THEME_STORAGE_KEY, stored)
          window.history.pushState({}, "", pathname)
          runInitScript()
          expect(isDark()).toBe(
            resolveTheme({
              preference: parseThemePreference(stored),
              systemPrefersDark: systemDark,
              pathname,
            }) === "dark"
          )
        }
      }
    }
  })
})

describe("applyTheme", () => {
  it("keeps the theme-color meta in step with the resolved theme", () => {
    stubSystemTheme(false)
    document.head.innerHTML = '<meta name="theme-color" content="#fcfcf9">'

    applyTheme("/invoices", "dark")
    expect(themeColors()).toEqual([THEME_COLORS.dark])

    applyTheme("/pay/token", "dark")
    expect(themeColors()).toEqual([THEME_COLORS.light])

    applyTheme("/invoices", "light")
    expect(themeColors()).toEqual([THEME_COLORS.light])
  })
})

describe("useTheme", () => {
  it("defaults to system", () => {
    stubSystemTheme(false)
    const { result } = renderHook(() => useTheme())
    expect(result.current.preference).toBe("system")
  })

  it("stores the choice under quits-theme and applies it", () => {
    stubSystemTheme(false)
    const { result } = renderHook(() => useTheme())

    act(() => result.current.setPreference("dark"))
    expect(result.current.preference).toBe("dark")
    expect(window.localStorage.getItem("quits-theme")).toBe("dark")
    expect(isDark()).toBe(true)

    act(() => result.current.setPreference("light"))
    expect(window.localStorage.getItem("quits-theme")).toBe("light")
    expect(isDark()).toBe(false)
  })

  it("reads the stored preference", () => {
    stubSystemTheme(false)
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark")
    const { result } = renderHook(() => useTheme())
    expect(result.current.preference).toBe("dark")
  })

  it("follows the system setting while the preference is system", () => {
    const system = stubSystemTheme(false)
    renderHook(() => useTheme())
    expect(isDark()).toBe(false)

    act(() => system.setDark(true))
    expect(isDark()).toBe(true)

    act(() => system.setDark(false))
    expect(isDark()).toBe(false)
  })

  it("ignores the system setting once a preference is chosen", () => {
    const system = stubSystemTheme(false)
    const { result } = renderHook(() => useTheme())
    act(() => result.current.setPreference("light"))

    act(() => system.setDark(true))
    expect(isDark()).toBe(false)
  })

  it("syncs a change made in another tab", () => {
    stubSystemTheme(false)
    const { result } = renderHook(() => useTheme())

    act(() => {
      window.localStorage.setItem(THEME_STORAGE_KEY, "dark")
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY, newValue: "dark" }))
    })
    expect(result.current.preference).toBe("dark")
    expect(isDark()).toBe(true)

    act(() => {
      window.localStorage.clear()
      window.dispatchEvent(new StorageEvent("storage", { key: null }))
    })
    expect(result.current.preference).toBe("system")
    expect(isDark()).toBe(false)
  })

  it("ignores storage changes to other keys", () => {
    stubSystemTheme(false)
    const { result } = renderHook(() => useTheme())
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: "dark" }))
    })
    expect(result.current.preference).toBe("system")
  })

  it("stops listening when nothing uses the theme any more", () => {
    const system = stubSystemTheme(false)
    const { unmount } = renderHook(() => useTheme())
    expect(system.listeners.size).toBe(1)
    unmount()
    expect(system.listeners.size).toBe(0)
  })

  it("keeps the page light on a public route even when dark is chosen", () => {
    stubSystemTheme(true)
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark")
    expect(applyTheme("/pay/token")).toBe("light")
    expect(isDark()).toBe(false)
    expect(applyTheme("/invoices")).toBe("dark")
    expect(isDark()).toBe(true)
  })
})
